import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '@shared/contract';
import { normalizeArchiveSettings, resolveBackfillCutoffMs, type ChannelBackfillHistory } from '@shared/archiveSettings';
import { DM_CHANNEL_TYPE, FORUM_CHANNEL_TYPE, compareSnowflakes, snowflakeFromMs, type RawMessage, type RawThread } from '@shared/discord';
import { MS_PER_DAY, MS_PER_MIN } from '@shared/units';
import { archiveHandlers } from '../src/core/archiveHandlers';
import { seedArchive, tempDb, rawMessage } from './helpers';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));
const { SyncService } = await import('../src/main/sync/syncService');

const NOW = Date.parse('2026-10-12T12:00:00Z');
const CHANNEL = '200000000000000001';
const OTHER = '200000000000000002';
const THREAD = '300000000000000001';
const OTHER_THREAD = '300000000000000002';
const SELF = '900000000000000001';
/** Enough history to require multiple Discord message pages. */
const HISTORY_MESSAGES = 120;
/** The sync's page size: a first sync stores the latest page whole, whatever the cutoff. */
const FIRST_PAGE = 50;
afterEach(() => vi.restoreAllMocks());

function harness(choice: ChannelBackfillHistory) {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  const db = tempDb();
  const archive = seedArchive(db, [{ id: CHANNEL }, { id: OTHER }]);
  let settings = normalizeArchiveSettings({ backfillHistory: { unit: 'days', amount: 1 }, channelBackfillHistory: { [CHANNEL]: choice } });
  const messages = new Map<string, RawMessage[]>();
  const threads = new Map<string, RawThread[]>();
  const events: AppEvent[] = [];
  const requests: { path: string; query: Record<string, unknown> }[] = [];
  const handlers = archiveHandlers({
    ready: () => ({ db, archive }), emit: (e) => void events.push(e), noteChanged: () => undefined,
    backfillFromMs: (id) => resolveBackfillCutoffMs(settings, id, Date.now(), archive.channelInfo(id)),
    selfId: () => SELF, lastSeenAt: () => NOW, applyTextTier: async () => undefined, autoArchiveSinceMs: () => null,
  });
  const core = {
    call: async (method: string, ...params: unknown[]) => method === 'getSetting' ? settings
      : (handlers as unknown as Record<string, (...p: unknown[]) => unknown>)[method]!(...params),
  };
  const api = {
    get: async (path: string, query: Record<string, unknown>, opts?: { guard?: () => Promise<void> }) => {
      await opts?.guard?.();
      requests.push({ path, query });
      const id = path.split('/')[1]!;
      const limit = Number(query['limit']);
      if (path.endsWith('/threads/search')) {
        const all = query['archived'] === 'true' ? [] : threads.get(id) ?? [];
        const offset = Number(query['offset']);
        return { threads: all.slice(offset, offset + limit), has_more: offset + limit < all.length };
      }
      const after = query['after'] as string | undefined;
      const before = query['before'] as string | undefined;
      return (messages.get(id) ?? [])
        .filter((m) => (!after || compareSnowflakes(m.id, after) > 0) && (!before || compareSnowflakes(m.id, before) < 0))
        .sort((a, b) => after ? compareSnowflakes(a.id, b.id) : compareSnowflakes(b.id, a.id))
        .slice(0, limit);
    },
  };
  const sync = new SyncService(api as never, core as never, (e) => void events.push(e), { guildList: () => [], channelsOf: () => null });
  const run = async (id = CHANNEL) => {
    const done = new Promise<void>((resolve) => { sync.onSettled = resolve; });
    sync.enqueue(id);
    await done;
    expect(events.filter((e) => e.type === 'sync-progress' && e.phase === 'error')).toEqual([]);
  };
  const choose = (id: string, history: ChannelBackfillHistory) => {
    settings = normalizeArchiveSettings({ ...settings, channelBackfillHistory: { ...settings.channelBackfillHistory, [id]: history } });
  };
  return { db, archive, messages, threads, requests, run, choose };
}

describe('history depth through sync', () => {
  it('extends a bounded channel to its first message on its next sync, and shallower choices keep it all', async () => {
    const h = harness({ unit: 'days', amount: 3 });
    const native = Array.from({ length: HISTORY_MESSAGES }, (_, i) => rawMessage(CHANNEL, NOW - (i + 1) * MS_PER_DAY, `message ${i}`));
    h.messages.set(CHANNEL, native);
    await h.run();
    expect(h.archive.syncState(CHANNEL)).toMatchObject({ count: FIRST_PAGE, backfillComplete: false });
    h.choose(CHANNEL, 'complete');
    await h.run();
    expect(h.archive.syncState(CHANNEL)).toMatchObject({ count: HISTORY_MESSAGES, oldestId: native.at(-1)!.id, backfillComplete: true });
    h.choose(CHANNEL, { sinceMs: NOW });
    await h.run();
    expect(h.archive.syncState(CHANNEL)).toMatchObject({ count: HISTORY_MESSAGES, oldestId: native.at(-1)!.id, backfillComplete: true });
    h.choose(CHANNEL, 'complete');
    const beforeRequests = h.requests.filter((r) => r.query['before']).length;
    await h.run();
    expect(h.requests.filter((r) => r.query['before'])).toHaveLength(beforeRequests);
  });

  it('no earlier history stores the latest page only, then catches messages after the fixed time', async () => {
    const h = harness({ sinceMs: NOW });
    const native = Array.from({ length: HISTORY_MESSAGES }, (_, i) => rawMessage(CHANNEL, NOW - (i + 1) * MS_PER_DAY, `message ${i}`));
    h.messages.set(CHANNEL, native);
    await h.run();
    expect(h.archive.syncState(CHANNEL)).toMatchObject({ count: FIRST_PAGE, backfillComplete: false });
    expect(h.requests.filter((r) => r.query['before'])).toEqual([]);
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 10 * MS_PER_DAY);
    native.push(rawMessage(CHANNEL, NOW + MS_PER_MIN, 'after the choice'));
    await h.run();
    expect(h.archive.syncState(CHANNEL)).toMatchObject({ count: FIRST_PAGE + 1, backfillComplete: false });
    expect(h.requests.filter((r) => r.query['before'])).toEqual([]);
    h.choose(CHANNEL, 'complete');
    await h.run();
    expect(h.archive.syncState(CHANNEL)).toMatchObject({ count: HISTORY_MESSAGES + 1, backfillComplete: true });
  });

  it('a DM uses its own history choice and still extends later', async () => {
    const h = harness({ sinceMs: NOW });
    h.archive.upsertPrivateChannel(SELF, { id: CHANNEL, type: DM_CHANNEL_TYPE, recipients: [{ id: OTHER, username: 'friend' }] }, true);
    h.archive.setOptIn(CHANNEL, true);
    h.messages.set(CHANNEL, Array.from({ length: HISTORY_MESSAGES }, (_, i) => rawMessage(CHANNEL, NOW - (i + 1) * MS_PER_DAY, `message ${i}`)));
    await h.run();
    expect(h.archive.syncState(CHANNEL)).toMatchObject({ count: FIRST_PAGE, backfillComplete: false });
    h.choose(CHANNEL, 'complete');
    await h.run();
    expect(h.archive.syncState(CHANNEL)).toMatchObject({ count: HISTORY_MESSAGES, backfillComplete: true });
  });

  it.each([0, FORUM_CHANNEL_TYPE])('discovers and fully backfills threads with their parent choice (kind %i)', async (kind) => {
    const h = harness('complete');
    h.archive.upsertChannels('g1', [{ id: CHANNEL, name: 'parent', type: kind }]);
    h.threads.set(CHANNEL, [{ id: THREAD, parent_id: CHANNEL, name: 'old thread', type: 11, last_message_id: snowflakeFromMs(NOW - 2 * MS_PER_DAY) }]);
    h.messages.set(THREAD, Array.from({ length: HISTORY_MESSAGES }, (_, i) => rawMessage(THREAD, NOW - (i + 2) * MS_PER_DAY, `message ${i}`)));
    h.threads.set(OTHER, [{ id: OTHER_THREAD, parent_id: OTHER, name: 'outside default', type: 11, last_message_id: snowflakeFromMs(NOW - 2 * MS_PER_DAY) }]);
    await h.run();
    await h.run(OTHER);
    expect(h.archive.syncState(THREAD)).toMatchObject({ count: HISTORY_MESSAGES, backfillComplete: true });
    expect(h.archive.channelInfo(OTHER_THREAD)).toBeNull();
  });

  it('a fixed-time parent still discovers later thread activity when now has moved on', async () => {
    const h = harness({ sinceMs: NOW });
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 10 * MS_PER_DAY);
    const later = NOW + MS_PER_MIN;
    h.threads.set(CHANNEL, [{ id: THREAD, parent_id: CHANNEL, name: 'later', type: 11, last_message_id: snowflakeFromMs(later) }]);
    h.messages.set(THREAD, [rawMessage(THREAD, later, 'later activity')]);
    await h.run();
    expect(h.archive.syncState(THREAD)).toMatchObject({ count: 1, backfillComplete: true });
  });
});
