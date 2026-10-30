import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Session } from 'electron';
import { sleep } from '@shared/async';
import type { PendingAttachment } from '@shared/contract';
import { DiscordHttpError } from '@shared/discord';
import { errorMessage } from '@shared/errors';
import type { PaceTiming } from '@shared/settings';
import { downloadHttpFailure, finalDownloadStatus, mediaKind } from '@shared/media';
import type { CoreClient } from '../coreClient';
import type { DiscordApi } from '../discord/api';
import { jittered } from '../sync/pace';
import type { RawMessage } from '@shared/discord';
import { PartialAttachment, filePartial, storeBody, type UploadCopy } from './attachmentStore';
import { PARTIAL_DOWNLOAD_PREFIX } from './attachmentStore';
import { EXPIRED_STATUSES, ensureEmoji } from './cdnCache';

export { PARTIAL_DOWNLOAD_PREFIX, publishStored } from './attachmentStore';

/** Rows claimed per pass; downloads run one at a time. */
const BATCH_SIZE = 20;
/** setTimeout's ceiling (a signed 32-bit ms count); a longer wait would fire at once. */
const TIMER_MAX_MS = 2 ** 31 - 1;

/** Discord or its CDN refused or no longer has the file (finalDownloadStatus); any other failure may pass. */
const isFinalFailure = (err: unknown): boolean => err instanceof DiscordHttpError && finalDownloadStatus(err.status);

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
  /** Copies whose messages never arrive remain until account change or quit; startup cleanup removes leftover .part- files. */
  private readonly copies = new Map<string, { copy: PartialAttachment; messageId: string; channelId: string }>();
  private readonly heldCopies = new Set<PartialAttachment>();
  private inFlight: string | null = null;
  private copyEpoch = 0;
  private disposed = false;

  async uploadCopy(): Promise<PartialAttachment | null> {
    if (!(await this.enabled()) || this.disposed) return null;
    const copy = new PartialAttachment(this.dir, (copy) => this.heldCopies.delete(copy));
    this.heldCopies.add(copy);
    return copy;
  }

  async acceptUploads(message: RawMessage, copies: UploadCopy[]): Promise<void> {
    const epoch = this.copyEpoch;
    const attachments = message.attachments as { id: string; size: number }[] | undefined;
    const transferred = new Set<PartialAttachment>();
    try {
      if (this.disposed || !(await this.enabled()) || !(await this.core.call('syncable', message.channel_id))) return;
      for (const [i, item] of copies.entries()) {
        const a = attachments?.[i];
        if (!item.copy || !a || a.size !== item.copy.bytes) continue;
        const source = await this.core.call('attachmentSource', a.id);
        if (epoch !== this.copyEpoch || this.disposed || this.inFlight === a.id || (source && source.status !== 'pending')) continue;
        const previous = this.copies.get(a.id);
        if (previous) void previous.copy.discard().catch(() => undefined);
        this.copies.set(a.id, { copy: item.copy, messageId: message.id, channelId: message.channel_id });
        transferred.add(item.copy);
      }
      this.kick();
    } finally {
      for (const item of copies) {
        if (item.copy && !transferred.has(item.copy)) {
          this.heldCopies.delete(item.copy);
          await item.copy.discard().catch(() => undefined);
        }
      }
    }
  }

  async discardCopies(): Promise<void> {
    this.copyEpoch++;
    this.copies.clear();
    const copies = [...this.heldCopies];
    this.heldCopies.clear();
    await Promise.all(copies.map((copy) => copy.discard().catch(() => undefined)));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    clearTimeout(this.retryTimer);
    await this.discardCopies();
  }

  private async record(id: string, stored: Awaited<ReturnType<typeof filePartial>>): Promise<void> {
    await this.core.call('attachmentStored', id, stored.sha, stored.bytes, stored.storedExt);
    await this.keepThumb(stored.name);
  }

  private running = false;
  private again = false;
  /** Stills of videos archived before posters were kept are fetched once per run. */
  private postersBackfilled = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly dir: string,
    private readonly emojiDir: string,
    private readonly ses: Session,
    private readonly api: DiscordApi,
    private readonly core: CoreClient,
    private readonly pace: () => Promise<PaceTiming>,
    private readonly enabled: () => Promise<boolean>,
    private readonly posters: PosterKeeper,
    /** Makes a newly stored file's thumbnail, by its stored name. */
    private readonly keepThumb: (storedName: string) => Promise<void>,
  ) {}

  /** Safe to call often (every archive change); coalesces into one drain loop. */
  kick(): void {
    if (this.disposed) return;
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
        if (this.disposed || !(await this.enabled())) { await this.discardCopies(); return; }
        // Attachments first, newest first (each batch re-reads the queue, so new messages jump ahead):
        // nothing else fetches them, so the Archive shows "downloading" until they arrive.
        for (let batch = await this.core.call('pendingAttachments', BATCH_SIZE); batch.length; batch = await this.core.call('pendingAttachments', BATCH_SIZE)) {
          for (const a of batch) {
            if (this.disposed || !(await this.enabled())) { await this.discardCopies(); return; }
            await this.downloadOne(a);
          }
        }
        await this.reconcileCopies();
        this.wakeForRetry(await this.core.call('nextAttachmentRetry'));
        // Then stills of videos archived before they were kept, while those are still on Discord.
        if (!this.postersBackfilled) {
          for (const a of await this.core.call('archivedVideos')) {
            if (this.again) break;
            if (this.disposed || !(await this.enabled())) { await this.discardCopies(); return; }
            await this.keepPoster(a);
          }
          this.postersBackfilled = !this.again;
        }
        // Then emoji: only a prefetch, since emoji on screen are fetched on demand by the media protocol.
        for (let batch = await this.core.call('pendingEmojis', BATCH_SIZE); batch.length && !this.again; batch = await this.core.call('pendingEmojis', BATCH_SIZE)) {
          // New archive activity (this.again) restarts the loop so fresh attachments go ahead of the prefetch.
          for (const e of batch) {
            if (this.disposed || !(await this.enabled())) { await this.discardCopies(); return; }
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

  private async reconcileCopies(): Promise<void> {
    for (const [id, entry] of this.copies) {
      // Message first: ingest writes a message and its attachments in one transaction, so a stored message with no row means none comes.
      const ingested = await this.core.call('messageExists', entry.messageId);
      const source = ingested ? await this.core.call('attachmentSource', id) : null;
      if ((ingested && (!source || source.status !== 'pending')) || !(await this.core.call('syncable', entry.channelId))) {
        this.copies.delete(id);
        await entry.copy.discard().catch(() => undefined);
      }
    }
  }

  /** Drains again when the earliest delayed retry is due, which no archive change may prompt. */
  private wakeForRetry(at: number | null): void {
    clearTimeout(this.retryTimer);
    if (at === null) return;
    this.retryTimer = setTimeout(() => this.kick(), Math.min(Math.max(0, at - Date.now()), TIMER_MAX_MS));
    this.retryTimer.unref();
  }

  /** Paced gap for history downloads and emoji prefetch (see Settings → Download pace). */
  private async gap(): Promise<void> {
    const { mediaMs, jitter } = await this.pace();
    await sleep(jittered(mediaMs, jitter));
  }

  private async downloadOne(a: PendingAttachment): Promise<void> {
    let copy = this.copies.get(a.id)?.copy;
    try {
      if (!copy && a.arrivedVia !== 'gateway') await this.gap();
      copy = this.copies.get(a.id)?.copy;
      this.copies.delete(a.id);
      this.inFlight = a.id;
      const stored = copy
        ? await copy.publish(a.filename)
        : await storeBody(this.dir, await this.fetchBody(a), a.filename);
      await this.record(a.id, stored);
    } catch (err) {
      await this.core.call('attachmentFailed', a.id, errorMessage(err), !isFinalFailure(err));
      return;
    } finally {
      this.inFlight = null;
      if (copy) {
        this.heldCopies.delete(copy);
        await copy.discard().catch(() => undefined);
      }
    }
    await this.keepPoster(a);
  }

  /** A video's still, unless kept already; a missing one is fetched again on first view. */
  private async keepPoster(a: PendingAttachment): Promise<void> {
    if (mediaKind(a) !== 'video' || this.posters.kept(a.id)) return;
    if (a.arrivedVia !== 'gateway') await this.gap();
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
    if (!res.ok || !res.body) throw new DiscordHttpError(downloadHttpFailure(res.status), res.status);
    return res.body;
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
