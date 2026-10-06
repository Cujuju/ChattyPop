import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Session } from 'electron';
import { sleep } from '@shared/async';
import type { PendingAttachment } from '@shared/contract';
import { errorMessage } from '@shared/errors';
import type { PaceTiming } from '@shared/settings';
import { attachmentFileName, attachmentShard, mediaKind } from '@shared/media';
import type { CoreClient } from '../coreClient';
import type { DiscordApi } from '../discord/api';
import { jittered } from '../sync/pace';
import { EXPIRED_STATUSES, ensureEmoji } from './cdnCache';

/** Rows claimed per pass; downloads run one at a time. */
const BATCH_SIZE = 20;

/** Downloads in flight are written under this prefix and renamed into place; never part of the archive (an archive move skips them). */
export const PARTIAL_DOWNLOAD_PREFIX = '.part-';

/** Video stills kept beside the store (thumbStore attachmentPoster), fetched while the attachment is on Discord so they outlive it. */
export interface PosterKeeper {
  kept(attachmentId: string): boolean;
  keep(a: PendingAttachment): Promise<unknown>;
}

export type AttachmentRef = Pick<PendingAttachment, 'id' | 'messageId' | 'channelId' | 'url'>;

/** Downloads queued attachments into a content-addressed store: <dir>/<attachmentShard>/<attachmentFileName>. */
/** One attachment to download outside the store (a plugin's attachments.fetchTo). */
export interface AttachmentFetch {
  attachmentId: string;
  messageId: string;
  channelId: string;
  url: string;
  /** Where to write it. */
  path: string;
}

export class AttachmentDownloader {
  private running = false;
  private again = false;
  /** Stills of videos archived before posters were kept are fetched once per run. */
  private postersBackfilled = false;

  constructor(
    private readonly dir: string,
    private readonly emojiDir: string,
    private readonly ses: Session,
    private readonly api: DiscordApi,
    private readonly core: CoreClient,
    private readonly pace: () => Promise<PaceTiming>,
    private readonly enabled: () => Promise<boolean>,
    private readonly posters: PosterKeeper,
  ) {}

  /** Safe to call often (every archive change); coalesces into one drain loop. */
  kick(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    void this.drain();
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      do {
        this.again = false;
        if (!(await this.enabled())) return;
        // Attachments first, newest first (each batch re-reads the queue, so new messages jump ahead):
        // nothing else fetches them, so the Archive shows "downloading" until they arrive.
        for (let batch = await this.core.call('pendingAttachments', BATCH_SIZE); batch.length; batch = await this.core.call('pendingAttachments', BATCH_SIZE)) {
          for (const a of batch) {
            if (!(await this.enabled())) return;
            await this.gap();
            await this.downloadOne(a);
          }
        }
        // Then stills of videos archived before they were kept, while those are still on Discord.
        if (!this.postersBackfilled) {
          for (const a of await this.core.call('archivedVideos')) {
            if (this.again) break;
            if (!(await this.enabled())) return;
            await this.keepPoster(a);
          }
          this.postersBackfilled = !this.again;
        }
        // Then emoji: only a prefetch, since emoji on screen are fetched on demand by the media protocol.
        for (let batch = await this.core.call('pendingEmojis', BATCH_SIZE); batch.length && !this.again; batch = await this.core.call('pendingEmojis', BATCH_SIZE)) {
          // New archive activity (this.again) restarts the loop so fresh attachments go ahead of the prefetch.
          for (const e of batch) {
            if (!(await this.enabled())) return;
            await this.gap();
            const error = await ensureEmoji(this.ses, this.emojiDir, e.id, e.animated).then(
              () => null,
              errorMessage,
            );
            await this.core.call('emojiDone', e.id, error);
          }
        }
      } while (this.again);
    } finally {
      this.running = false;
    }
  }

  /** Paced gap before each CDN request (see Settings → Download pace). */
  private async gap(): Promise<void> {
    const { mediaMs, jitter } = await this.pace();
    await sleep(jittered(mediaMs, jitter));
  }

  private async downloadOne(a: PendingAttachment): Promise<void> {
    try {
      const body = await this.fetchBody(a);
      const { sha, bytes } = await this.store(body, a.filename);
      await this.core.call('attachmentStored', a.id, sha, bytes);
    } catch (err) {
      await this.core.call('attachmentFailed', a.id, errorMessage(err));
      return;
    }
    await this.keepPoster(a);
  }

  /** A video's still, unless kept already; a missing one is fetched again on first view. */
  private async keepPoster(a: PendingAttachment): Promise<void> {
    if (mediaKind(a) !== 'video' || this.posters.kept(a.id)) return;
    await this.gap();
    await this.posters.keep(a).catch(() => undefined);
  }

  /** Downloads outside-store attachments atomically to r.path. Returns null or error; incomplete and repeated downloads never expose partial files. */
  async fetchTo(r: AttachmentFetch): Promise<string | null> {
    const partial = join(dirname(r.path), `${PARTIAL_DOWNLOAD_PREFIX}${randomUUID()}-${basename(r.path)}`);
    try {
      const body = await this.fetchBody({ id: r.attachmentId, messageId: r.messageId, channelId: r.channelId, url: r.url });
      await pipeline(Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>), createWriteStream(partial));
      await rename(partial, r.path);
      return null;
    } catch (err) {
      await rm(partial, { force: true });
      return errorMessage(err);
    }
  }

  /** The file's body, re-reading the message once for a fresh signed URL when the stored one expired. */
  private async fetchBody(a: AttachmentRef): Promise<ReadableStream<Uint8Array>> {
    let res = await this.ses.fetch(a.url);
    if (EXPIRED_STATUSES.has(res.status)) {
      const fresh = await freshAttachmentUrl(this.api, a);
      if (fresh) res = await this.ses.fetch(fresh);
    }
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    return res.body;
  }

  /** Streams to a temp file while hashing, then moves it to its content address (dedupes identical files). */
  private async store(body: ReadableStream<Uint8Array>, filename: string): Promise<{ sha: string; bytes: number }> {
    await mkdir(this.dir, { recursive: true });
    const tmp = join(this.dir, `${PARTIAL_DOWNLOAD_PREFIX}${process.pid}-${Date.now()}`);
    const hash = createHash('sha256');
    const source = Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>);
    let bytes = 0;
    source.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      bytes += chunk.length;
    });
    await pipeline(source, createWriteStream(tmp));
    const sha = hash.digest('hex');
    const shardDir = join(this.dir, attachmentShard(sha));
    const dest = join(shardDir, attachmentFileName(sha, filename));
    await mkdir(shardDir, { recursive: true });
    if (existsSync(dest)) await rm(tmp);
    else await rename(tmp, dest);
    return { sha, bytes };
  }
}

/** A fresh signed CDN URL for an attachment whose stored one expired, read from its message; undefined once it's gone. */
export async function freshAttachmentUrl(api: Pick<DiscordApi, 'get'>, a: AttachmentRef): Promise<string | undefined> {
  const page = await api.get<{ id: string; attachments?: { id: string; url: string }[] }[]>(`channels/${a.channelId}/messages`, {
    around: a.messageId,
    limit: 1,
  });
  return page.find((m) => m.id === a.messageId)?.attachments?.find((x) => x.id === a.id)?.url;
}
