// A failed attachment download: a transient failure is retried on a bounded backoff (also across restarts, since the
// schedule is stored), a final answer fails at once, and a refetch carrying a new signed URL queues a failed one again.
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import type { Session } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordHttpError } from '@shared/discord';
import type { CoreClient } from '../src/main/coreClient';
import type { DiscordApi } from '../src/main/discord/api';
import { AttachmentDownloader } from '../src/main/media/attachmentDownloader';
import { openDb, type Db } from '../src/core/db';
import { deriveMessage } from '../src/core/derive/deriveMessage';
import { DOWNLOAD_RETRIES_MAX, attachmentFailed, downloadRetryDelayMs, mediaQueueHandlers, nextAttachmentRetry, pendingAttachments } from '../src/core/mediaQueue';
import { applyMigrations, migrationIndex, rawMessage, seedArchive, tempDb, tempDir } from './helpers';

const TS = Date.parse('2026-01-01T00:00:00Z');
const URL_A = 'https://cdn.example/a.png?hm=1';
const URL_B = 'https://cdn.example/a.png?hm=2';
const HTTP_NOT_FOUND = 404;
let db: Db;
const id = '300000000000000001';
let messageId: string;

const state = () => db.prepare('SELECT status, attempts, retry_at AS retryAt, error FROM attachments WHERE id = ?').get(id) as
  { status: string; attempts: number; retryAt: number | null; error: string | null };
const refetch = (url: string) => deriveMessage(db, { id: messageId, channel_id: 'c1', attachments: [{ id, filename: 'a.png', url }] }, 'u1');
const queued = (now: number) => pendingAttachments(db, 1, now).map((a) => a.id);

beforeEach(() => {
  db = tempDb();
  const m = rawMessage('c1', TS, '', { attachments: [{ id, filename: 'a.png', content_type: 'image/png', url: URL_A }] });
  seedArchive(db, [{ id: 'c1' }]).ingestMessages([m], 'gateway');
  messageId = m.id;
});
afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe('attachment download retries', () => {
  it('retries a transient failure after a doubling delay, then fails after the bounded retries', () => {
    let now = TS;
    for (let attempt = 1; attempt <= DOWNLOAD_RETRIES_MAX; attempt++) {
      expect(queued(now)).toEqual([id]);
      attachmentFailed(db, id, 'fetch failed', true, now);
      const due = now + downloadRetryDelayMs(attempt);
      expect(state()).toMatchObject({ status: 'pending', attempts: attempt, retryAt: due });
      expect(nextAttachmentRetry(db)).toBe(due);
      expect(queued(due - 1)).toEqual([]);
      now = due;
    }
    expect(downloadRetryDelayMs(2)).toBe(2 * downloadRetryDelayMs(1));
    expect(queued(now)).toEqual([id]);
    attachmentFailed(db, id, 'fetch failed', true, now);
    expect(state()).toMatchObject({ status: 'failed', retryAt: null, error: 'fetch failed' });
    expect(nextAttachmentRetry(db)).toBeNull();
    expect(queued(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it('fails a final answer at once', () => {
    attachmentFailed(db, id, 'HTTP 404', false, TS);
    expect(state()).toMatchObject({ status: 'failed', retryAt: null });
    expect(queued(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it('queues a failed download again when a refetch brings a new signed URL, not the same one', () => {
    attachmentFailed(db, id, 'HTTP 404', false, TS);
    refetch(URL_A);
    expect(state().status).toBe('failed');
    refetch(URL_B);
    expect(state()).toMatchObject({ status: 'pending', attempts: 0, retryAt: null });
    expect(queued(TS)).toEqual([id]);
  });

  /** The downloader over the real queue, answering CDN fetches with `respond`. */
  function downloader(respond: () => Promise<Response>, api: Partial<DiscordApi> = {}) {
    const handlers = mediaQueueHandlers(() => db, () => undefined);
    const core = { call: async (method: keyof typeof handlers, ...args: unknown[]) => (handlers[method] as (...a: unknown[]) => unknown)(...args) } as unknown as CoreClient;
    const ses = { fetch: respond } as unknown as Session;
    const posters = { kept: () => true, keep: async () => undefined };
    return new AttachmentDownloader(tempDir(), tempDir(), ses, api as DiscordApi, core, async () => ({ mediaMs: 0, jitter: 0 }) as never, async () => true, posters, async () => undefined);
  }

  it('stores a file whose first download dropped, on the retry it schedules', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: TS });
    let drops = 1;
    downloader(async () => {
      if (drops-- > 0) throw new TypeError('fetch failed');
      return new Response('bytes');
    }).kick();
    await vi.waitFor(() => expect(state()).toMatchObject({ status: 'pending', attempts: 1 }));
    await vi.advanceTimersByTimeAsync(downloadRetryDelayMs(1));
    await vi.waitFor(() => expect(state().status).toBe('stored'));
  });

  it('fails a file Discord no longer has without retrying', async () => {
    const api = { get: async () => [] } as unknown as DiscordApi;
    downloader(async () => new Response(null, { status: HTTP_NOT_FOUND }), api).kick();
    await vi.waitFor(() => expect(state()).toMatchObject({ status: 'failed', retryAt: null }));
    expect(state().error).toBe(new DiscordHttpError(`HTTP ${HTTP_NOT_FOUND}`, HTTP_NOT_FOUND).message);
  });
});

describe('download failures stored before retries existed', () => {
  it('go back in the queue when a retry may pass; final answers and failures since stay failed', () => {
    const path = join(tempDir(), 'old.db');
    const old = new Database(path);
    // The profile as it stood once downloads counted attempts, before legacy failures were sorted.
    applyMigrations(old, 0, migrationIndex('ADD COLUMN retry_at') + 1);
    const add = old.prepare("INSERT INTO attachments (id, message_id, channel_id, filename, url, status, error, attempts) VALUES (?, 'm', 'c', 'a.png', 'u', 'failed', ?, ?)");
    const rows = [
      ['reset', 'read ECONNRESET', 0],
      ['server', 'HTTP 503', 0],
      ['limited', 'HTTP 429', 0],
      ['gone', 'HTTP 404', 0],
      ['refused', 'HTTP 403', 0],
      ['final-since', 'HTTP 404', 1],
      ['exhausted-since', 'fetch failed', DOWNLOAD_RETRIES_MAX + 1],
    ] as const;
    for (const [rowId, error, attempts] of rows) add.run(rowId, error, attempts);
    old.close();
    const upgraded = openDb(path);
    const statuses = upgraded.prepare('SELECT id, status, attempts, retry_at AS retryAt FROM attachments ORDER BY id').all();
    upgraded.close();
    expect(statuses).toEqual([
      { id: 'exhausted-since', status: 'failed', attempts: DOWNLOAD_RETRIES_MAX + 1, retryAt: null },
      { id: 'final-since', status: 'failed', attempts: 1, retryAt: null },
      { id: 'gone', status: 'failed', attempts: 0, retryAt: null },
      { id: 'limited', status: 'pending', attempts: 0, retryAt: null },
      { id: 'refused', status: 'failed', attempts: 0, retryAt: null },
      { id: 'reset', status: 'pending', attempts: 0, retryAt: null },
      { id: 'server', status: 'pending', attempts: 0, retryAt: null },
    ]);
  });
});
