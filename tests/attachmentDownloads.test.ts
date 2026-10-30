// The attachment downloader's store: a download that fails leaves nothing behind, and partial files a crashed run
// left are removed at the next start, before anything writes.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from 'electron';
import { describe, expect, it } from 'vitest';
import type { PendingAttachment } from '@shared/contract';
import { attachmentShard } from '@shared/media';
import type { CoreClient } from '../src/main/coreClient';
import type { DiscordApi } from '../src/main/discord/api';
import { AttachmentDownloader } from '../src/main/media/attachmentDownloader';
import { PARTIAL_DOWNLOAD_PREFIX } from '../src/main/media/attachmentStore';
import { mediaDirs, removeAbandonedPartials } from '../src/main/media/mediaDirs';
import { tempDir } from './helpers';

const PARTIAL_BYTES = 1024;
const pending = (id: string, filename: string): PendingAttachment => ({ id, messageId: 'm', channelId: 'c', url: `https://cdn.example/${id}`, filename, contentType: null });
const partials = (dir: string): string[] => readdirSync(dir).filter((name) => name.startsWith(PARTIAL_DOWNLOAD_PREFIX));

/** A body that sends some bytes, then drops like a reset connection. */
const droppedBody = () =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(PARTIAL_BYTES));
      c.error(new Error('connection reset'));
    },
  });

/** A downloader over one batch of `queue`, answering each fetch with `respond`; resolves its core calls once drained. */
function download(queue: PendingAttachment[], respond: (url: string) => Response) {
  const dir = tempDir();
  const batches = [queue];
  const calls: [string, ...unknown[]][] = [];
  let drained!: () => void;
  const done = new Promise<void>((resolve) => (drained = resolve));
  const core = {
    call: async (method: string, ...args: unknown[]) => {
      calls.push([method, ...args]);
      if (method === 'pendingAttachments') return batches.shift() ?? [];
      if (method === 'pendingEmojis') return (drained(), []);
      if (method === 'nextAttachmentRetry') return null;
      return [];
    },
  } as unknown as CoreClient;
  const ses = { fetch: async (url: string) => respond(url) } as unknown as Session;
  const posters = { kept: () => true, keep: async () => undefined };
  const downloader = new AttachmentDownloader(dir, tempDir(), ses, {} as DiscordApi, core, async () => ({ mediaMs: 0, jitter: 0 }) as never, async () => true, posters, async () => undefined);
  downloader.kick();
  return { dir, calls, done };
}

describe('attachment store downloads', () => {
  it('removes the partial file of a download that fails midway', async () => {
    const d = download([pending('a1', 'big.bin')], () => new Response(droppedBody()));
    await d.done;
    expect(d.calls.find(([method]) => method === 'attachmentFailed')).toBeTruthy();
    expect(partials(d.dir)).toEqual([]);
  });

  it('keeps one file per content hash, recording the extension it is stored under', async () => {
    const d = download([pending('a1', 'same.png'), pending('a2', 'same.jpg'), pending('a3', 'same.PNG')], () => new Response('same bytes'));
    await d.done;
    const sha = createHash('sha256').update('same bytes').digest('hex');
    expect(readdirSync(join(d.dir, attachmentShard(sha)))).toEqual([`${sha}.png`]);
    expect(d.calls.filter(([method]) => method === 'attachmentStored')).toEqual([
      ['attachmentStored', 'a1', sha, 'same bytes'.length, null],
      ['attachmentStored', 'a2', sha, 'same bytes'.length, 'png'],
      ['attachmentStored', 'a3', sha, 'same bytes'.length, null],
    ]);
  });

  it('removes partial files a crashed run left in the store and previews, keeping everything else', () => {
    const dirs = mediaDirs(tempDir());
    for (const dir of [dirs.attachments, dirs.previews]) {
      mkdirSync(join(dir, 'ab'), { recursive: true });
      writeFileSync(join(dir, `${PARTIAL_DOWNLOAD_PREFIX}1234-5678`), Buffer.alloc(PARTIAL_BYTES));
      writeFileSync(join(dir, 'kept.jpg'), 'kept');
    }
    removeAbandonedPartials(dirs);
    for (const dir of [dirs.attachments, dirs.previews]) expect(readdirSync(dir).sort()).toEqual(['ab', 'kept.jpg']);
    expect(() => removeAbandonedPartials(mediaDirs(tempDir()))).not.toThrow();
  });
});

