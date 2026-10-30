import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachmentShard } from '@shared/media';
import type { CoreClient } from '../src/main/coreClient';
import { AttachmentDownloader } from '../src/main/media/attachmentDownloader';
import { PARTIAL_DOWNLOAD_PREFIX, storeBody } from '../src/main/media/attachmentStore';
import { mediaQueueHandlers, pendingAttachments } from '../src/core/mediaQueue';
import { rawMessage, seedArchive, tempDb, tempDir } from './helpers';

const ID = '300000000000000001';
const BYTES = Buffer.from('local upload');
const sha = createHash('sha256').update(BYTES).digest('hex');
const databases: ReturnType<typeof tempDb>[] = [];
afterEach(() => { vi.useRealTimers(); databases.splice(0).forEach((db) => db.close()); });

function setup(size = BYTES.length) {
  const db = tempDb();
  databases.push(db);
  const archive = seedArchive(db, [{ id: 'c1' }]);
  const message = rawMessage('c1', Date.now(), '', { attachments: [{ id: ID, filename: 'a.png', size, url: 'https://cdn/a', content_type: 'image/png' }] });
  const dir = tempDir();
  const handlers = mediaQueueHandlers(() => db, () => dir, () => {});
  const state = { enabled: true };
  const fetch = vi.fn(async () => new Response(BYTES));
  const thumb = vi.fn(async () => {});
  const pace = vi.fn(async () => ({ mediaMs: 1000, jitter: 0 }));
  const call = vi.fn(async (method: string, ...args: unknown[]) => {
    if (method === 'syncable') return archive.isOptedIn(message.channel_id);
    return (handlers as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!(...args);
  });
  const downloader = new AttachmentDownloader(dir, tempDir(), { fetch } as never, {} as never,
    { call } as unknown as CoreClient, pace as never, async () => state.enabled,
    { kept: () => true, keep: async () => {} }, thumb);
  const rows = () => db.prepare('SELECT status, sha256, stored_bytes AS bytes, stored_ext AS ext FROM attachments WHERE id = ?').get(ID);
  const partials = () => readdirSync(dir).filter((name) => name.startsWith(PARTIAL_DOWNLOAD_PREFIX));
  return { db, archive, message, dir, state, fetch, thumb, pace, call, downloader, rows, partials };
}

async function drain(d: ReturnType<typeof setup>) {
  d.downloader.kick();
  await vi.waitFor(() => expect(d.downloader['running']).toBe(false));
}

describe('own upload archive', () => {
  it('files a provided copy by position without CDN or history gap', async () => {
    const d = setup();
    const copy = (await d.downloader.uploadCopy())!;
    await copy.write(BYTES);
    await d.downloader.acceptUploads(d.message, [copy]);
    expect(d.call.mock.calls.some(([m]) => m === 'applyGatewayEvent')).toBe(false);
    expect(d.rows()).toBeUndefined();
    d.archive.ingestMessages([d.message], 'sync');
    await drain(d);
    expect(d.rows()).toEqual({ status: 'stored', sha256: sha, bytes: BYTES.length, ext: null });
    expect(readFileSync(join(d.dir, attachmentShard(sha), `${sha}.png`))).toEqual(BYTES);
    expect(d.thumb).toHaveBeenCalledWith(`${sha}.png`);
    expect(d.fetch).not.toHaveBeenCalled();
    expect(d.pace).not.toHaveBeenCalled();
    expect(d.partials()).toEqual([]);
  });

  it('discards mismatched sizes and downloads normally', async () => {
    const d = setup(BYTES.length + 1);
    const copy = (await d.downloader.uploadCopy())!;
    await copy.write(BYTES);
    await d.downloader.acceptUploads(d.message, [copy]);
    expect(d.partials()).toEqual([]);
    d.archive.ingestMessages([d.message], 'gateway');
    await drain(d);
    expect(d.fetch).toHaveBeenCalledTimes(1);
    expect(d.rows()).toMatchObject({ status: 'stored' });
  });

  it.each(['removed', 'stored', 'failed', 'missing attachment', 'unarchived'] as const)('discards a handed-off copy at the next drain when %s', async (reason) => {
    const d = setup();
    const copy = (await d.downloader.uploadCopy())!;
    await copy.write(BYTES);
    await d.downloader.acceptUploads(d.message, [copy]);
    await drain(d);
    expect(d.partials()).toHaveLength(1);

    if (reason === 'unarchived') d.archive.setOptIn('c1', false);
    else {
      d.archive.ingestMessages([reason === 'missing attachment' ? { ...d.message, attachments: [] } : d.message], 'gateway');
      if (reason === 'removed') d.db.prepare('UPDATE attachments SET removed_at = ? WHERE id = ?').run(Date.now(), ID);
      if (reason === 'stored' || reason === 'failed') d.db.prepare('UPDATE attachments SET status = ? WHERE id = ?').run(reason, ID);
    }

    await drain(d);
    expect(d.partials()).toEqual([]);
    expect(d.fetch).not.toHaveBeenCalled();
    if (reason === 'removed') expect(d.rows()).toMatchObject({ status: 'failed' });
  });

  it('keeps a handed-off copy across empty drains until its message is ingested', async () => {
    const d = setup();
    const copy = (await d.downloader.uploadCopy())!;
    await copy.write(BYTES);
    await d.downloader.acceptUploads(d.message, [copy]);
    await drain(d);
    await drain(d);
    expect(d.rows()).toBeUndefined();
    expect(d.partials()).toHaveLength(1);
    expect(d.fetch).not.toHaveBeenCalled();

    d.archive.ingestMessages([d.message], 'gateway');
    await drain(d);
    expect(d.rows()).toMatchObject({ status: 'stored', sha256: sha });
    expect(d.partials()).toEqual([]);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it('keeps a copy whose message is ingested while the drain checks it', async () => {
    const d = setup();
    const copy = (await d.downloader.uploadCopy())!;
    await copy.write(BYTES);
    await d.downloader.acceptUploads(d.message, [copy]);
    const answer = d.call.getMockImplementation()!;
    let ingested = false;
    d.call.mockImplementation(async (method, ...args) => {
      const result = await answer(method, ...args);
      // Ingest lands right after the drain's first look at this copy, whichever query that is.
      if (!ingested && (method === 'messageExists' || method === 'attachmentSource') && !result) {
        ingested = true;
        d.archive.ingestMessages([d.message], 'gateway');
      }
      return result;
    });
    await drain(d);
    d.call.mockImplementation(answer);
    await drain(d);
    expect(d.rows()).toMatchObject({ status: 'stored', sha256: sha });
    expect(d.fetch).not.toHaveBeenCalled();
    expect(d.partials()).toEqual([]);
  });

  it.each(['missing', 'unarchived', 'disabled', 'account', 'dispose'] as const)('discards copies on %s', async (reason) => {
    const d = setup();
    const copy = (await d.downloader.uploadCopy())!;
    await copy.write(BYTES);
    if (reason === 'unarchived') d.archive.setOptIn('c1', false);
    if (reason === 'disabled') d.state.enabled = false;
    await d.downloader.acceptUploads(reason === 'missing' ? { ...d.message, attachments: [] } : d.message, [copy]);
    if (reason === 'account') d.downloader.discardCopies();
    if (reason === 'dispose') d.downloader.dispose();
    await vi.waitFor(() => expect(d.partials()).toEqual([]));
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it('uses the extension already stored for identical bytes', async () => {
    const d = setup();
    await storeBody(d.dir, new Response(BYTES).body!, 'other.jpg');
    const copy = (await d.downloader.uploadCopy())!;
    await copy.write(BYTES);
    await d.downloader.acceptUploads(d.message, [copy]);
    d.archive.ingestMessages([d.message], 'gateway');
    await drain(d);
    expect(d.rows()).toMatchObject({ status: 'stored', ext: 'jpg' });
    expect(d.thumb).toHaveBeenCalledWith(`${sha}.jpg`);
  });

  it.each([false, true])('lets an in-flight CDN transfer finish and discards the arriving copy (failure=%s)', async (failure) => {
    const d = setup();
    const copy = (await d.downloader.uploadCopy())!;
    await copy.write(BYTES);
    d.archive.ingestMessages([d.message], 'gateway');
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    d.fetch.mockImplementation(async () => new Response(body));
    d.downloader.kick();
    await vi.waitFor(() => expect(d.fetch).toHaveBeenCalledTimes(1));
    await d.downloader.acceptUploads(d.message, [copy]);
    expect(d.rows()).toMatchObject({ status: 'pending' });
    if (failure) controller.error(new Error('connection reset'));
    else { controller.enqueue(BYTES); controller.close(); }
    await vi.waitFor(() => expect(d.call.mock.calls.some(([m]) => m === 'pendingEmojis')).toBe(true));
    expect(d.call.mock.calls.filter(([m]) => m === 'attachmentStored')).toHaveLength(failure ? 0 : 1);
    expect(d.call.mock.calls.filter(([m]) => m === 'attachmentFailed')).toHaveLength(failure ? 1 : 0);
    expect(d.partials()).toEqual([]);
  });

  it('discards a copy for an attachment already stored', async () => {
    const d = setup();
    d.archive.ingestMessages([d.message], 'gateway');
    await drain(d);
    const copy = (await d.downloader.uploadCopy())!;
    await copy.write(BYTES);
    await d.downloader.acceptUploads(d.message, [copy]);
    expect(d.call.mock.calls.filter(([m]) => m === 'attachmentStored')).toHaveLength(1);
    expect(d.partials()).toEqual([]);
  });

});

describe('attachment arrival pacing', () => {
  it.each(['gateway', 'sync', 'import'] as const)('%s arrival carries its pacing fact in the queue', async (via) => {
    vi.useFakeTimers();
    const d = setup();
    d.archive.ingestMessages([d.message], via);
    expect(pendingAttachments(d.db, 20)[0]?.arrivedVia).toBe(via);
    d.downloader.kick();
    await vi.advanceTimersByTimeAsync(0);
    if (via !== 'gateway') {
      expect(d.fetch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
    }
    await vi.waitFor(() => expect(d.fetch).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(d.call.mock.calls.some(([m]) => m === 'pendingEmojis')).toBe(true));
    expect(d.pace).toHaveBeenCalledTimes(via === 'gateway' ? 0 : 1);
  });
});
