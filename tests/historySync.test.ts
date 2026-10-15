import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '@shared/contract';
import { normalizeArchiveSettings, resolveBackfillCutoffMs, type ArchiveSettings, type ChannelBackfillHistory } from '@shared/archiveSettings';
import { HISTORY_PAGE_SIZE, estimateBackfillPages } from '@shared/backfillProgress';
import { DM_CHANNEL_TYPE, FORUM_CHANNEL_TYPE, compareSnowflakes, snowflakeFromMs, type RawMessage, type RawThread } from '@shared/discord';
import { MS_PER_DAY, MS_PER_MIN } from '@shared/units';
import { archiveHandlers } from '../src/core/archiveHandlers';
import { ARRIVAL } from '../src/core/arrival';
import { seedArchive, tempDb, rawMessage } from './helpers';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));
const { SyncService } = await import('../src/main/sync/syncService');
const { deepenedChannels } = await import('../src/main/sync/depthChange');

const NOW = Date.parse('2026-10-12T12:00:00Z');
const CHANNEL = '200000000000000001';
const OTHER = '200000000000000002';
const THREAD = '300000000000000001';
const OTHER_THREAD = '300000000000000002';
const SELF = '900000000000000001';
/** Enough history to require multiple Discord message pages. */
const HISTORY_MESSAGES = 120;
/** A first sync stores the latest page whole, whatever the cutoff. */
const FIRST_PAGE = HISTORY_PAGE_SIZE;
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
  /** Why every Discord request fails, or only thread listing, while set; `inFlight` runs while a sent request awaits its answer. */
  const discord: { failure: string | null; threadFailure: string | null; inFlight: ((path: string, query: Record<string, unknown>) => void) | null } = { failure: null, threadFailure: null, inFlight: null };
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
      discord.inFlight?.(path, query);
      if (discord.failure) throw new Error(discord.failure);
      requests.push({ path, query });
      const id = path.split('/')[1]!;
      const limit = Number(query['limit']);
      if (path.endsWith('/threads/search')) {
        if (discord.threadFailure) throw new Error(discord.threadFailure);
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
  const set = (patch: Partial<ArchiveSettings>) => {
    settings = normalizeArchiveSettings({ ...settings, ...patch });
  };
  const choose = (id: string, history: ChannelBackfillHistory) => set({ channelBackfillHistory: { ...settings.channelBackfillHistory, [id]: history } });
  return { db, archive, messages, threads, requests, discord, sync, run, set, choose, settings: () => settings };
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

/** One message a day back from NOW, newest first: message i is i + `firstDay` days old. */
const daily = (channelId: string, firstDay = 1): RawMessage[] =>
  Array.from({ length: HISTORY_MESSAGES }, (_, i) => rawMessage(channelId, NOW - (i + firstDay) * MS_PER_DAY, `message ${i}`));

describe('history asked for past the depth setting', () => {
  it('fetches back to the time, answers when it is reached and leaves the setting alone', async () => {
    const h = harness({ unit: 'days', amount: 3 });
    h.messages.set(CHANNEL, daily(CHANNEL));
    const before = h.settings();
    expect(await h.sync.historyTo([CHANNEL], NOW - 80 * MS_PER_DAY)).toEqual([{ channelId: CHANNEL, outcome: 'reached' }]);
    // Whole pages: the second one ends past the time asked for.
    expect(h.archive.syncState(CHANNEL)).toMatchObject({ count: 2 * HISTORY_PAGE_SIZE, backfillComplete: false });
    expect(h.settings()).toBe(before);
    const older = h.requests.filter((r) => r.query['before']).length;
    await h.run();
    expect(h.requests.filter((r) => r.query['before'])).toHaveLength(older);
  });

  it("covers the channel's threads, those the setting calls done too, before it answers", async () => {
    const h = harness({ unit: 'days', amount: 3 });
    h.archive.upsertChannels('g1', [{ id: CHANNEL, name: 'parent', type: 0 }]);
    h.threads.set(CHANNEL, [{ id: THREAD, parent_id: CHANNEL, name: 'thread', type: 11, last_message_id: snowflakeFromMs(NOW - 2 * MS_PER_DAY) }]);
    h.messages.set(THREAD, daily(THREAD, 2));
    await h.run();
    expect(h.archive.syncState(THREAD)).toMatchObject({ count: FIRST_PAGE });
    expect(await h.sync.historyTo([CHANNEL], NOW - 100 * MS_PER_DAY)).toEqual([{ channelId: CHANNEL, outcome: 'reached' }]);
    expect(h.archive.syncState(THREAD)).toMatchObject({ count: 2 * HISTORY_PAGE_SIZE });
  });

  it('answers stopped when sync is paused or dropped, and failed with the reason when a request fails', async () => {
    const h = harness({ unit: 'days', amount: 3 });
    h.messages.set(CHANNEL, daily(CHANNEL));
    h.set({ syncEnabled: false });
    expect(await h.sync.historyTo([CHANNEL], NOW - 80 * MS_PER_DAY)).toEqual([{ channelId: CHANNEL, outcome: 'stopped' }]);
    h.set({ syncEnabled: true });
    h.discord.failure = 'Discord said no';
    expect(await h.sync.historyTo([CHANNEL, CHANNEL], NOW - 80 * MS_PER_DAY)).toEqual([{ channelId: CHANNEL, outcome: 'failed', message: 'Discord said no' }]);
    h.discord.failure = null;
    const waiting = h.sync.historyTo([CHANNEL, OTHER], NOW - 80 * MS_PER_DAY);
    h.sync.halt();
    expect((await waiting).map((r) => r.outcome)).toEqual(['stopped', 'stopped']);
    expect(await h.sync.historyTo([CHANNEL], NOW)).toEqual([{ channelId: CHANNEL, outcome: 'stopped' }]);
  });

  it("answers a forum stopped when sync is paused, and any parent failed when its threads can't be listed", async () => {
    const h = harness({ unit: 'days', amount: 3 });
    h.archive.upsertChannels('g1', [{ id: CHANNEL, name: 'forum', type: FORUM_CHANNEL_TYPE }, { id: OTHER, name: 'text', type: 0 }]);
    h.set({ syncEnabled: false });
    expect(await h.sync.historyTo([CHANNEL], NOW - 80 * MS_PER_DAY)).toEqual([{ channelId: CHANNEL, outcome: 'stopped' }]);
    h.set({ syncEnabled: true });
    h.discord.threadFailure = 'Missing Access';
    const failed = (channelId: string) => ({ channelId, outcome: 'failed', message: "Its threads couldn't be listed: Missing Access" });
    expect(await h.sync.historyTo([CHANNEL, OTHER], NOW - 80 * MS_PER_DAY)).toEqual([failed(CHANNEL), failed(OTHER)]);
  });

  it("deepens a thread's own shallower wait to its parent's time", async () => {
    const h = harness({ unit: 'days', amount: 3 });
    h.archive.upsertChannels('g1', [{ id: CHANNEL, name: 'parent', type: 0 }]);
    h.threads.set(CHANNEL, [{ id: THREAD, parent_id: CHANNEL, name: 'thread', type: 11, last_message_id: snowflakeFromMs(NOW - 2 * MS_PER_DAY) }]);
    h.messages.set(THREAD, daily(THREAD, 2));
    await h.run();
    const waits = await Promise.all([h.sync.historyTo([CHANNEL], NOW - 100 * MS_PER_DAY), h.sync.historyTo([THREAD], NOW - 3 * MS_PER_DAY)]);
    expect(waits.flat().map((r) => r.outcome)).toEqual(['reached', 'reached']);
    expect(h.archive.syncState(THREAD)).toMatchObject({ count: 2 * HISTORY_PAGE_SIZE });
  });

  it('fetches every message of the millisecond it is asked back to', async () => {
    const h = harness({ unit: 'days', amount: 3 });
    const START = NOW - 60 * MS_PER_DAY;
    const boundary = [rawMessage(CHANNEL, START, 'later in the start', { id: snowflakeFromMs(START, 1) }), rawMessage(CHANNEL, START, 'first in the start')];
    // A page of newer messages that ends with the later of the two.
    h.messages.set(CHANNEL, [...daily(CHANNEL).slice(0, HISTORY_PAGE_SIZE - 1), ...boundary, ...daily(CHANNEL, 61)]);
    expect(await h.sync.historyTo([CHANNEL], START)).toEqual([{ channelId: CHANNEL, outcome: 'reached' }]);
    expect(h.archive.syncState(CHANNEL).count).toBeGreaterThan(HISTORY_PAGE_SIZE);
  });
});

describe('a channel no longer archived while its page is fetched', () => {
  it('stores nothing and moves no cursor, so archiving it again fetches that page', async () => {
    const h = harness({ unit: 'days', amount: 3 });
    h.messages.set(CHANNEL, daily(CHANNEL));
    h.discord.inFlight = () => h.archive.setOptIn(CHANNEL, false);
    await h.run();
    h.discord.inFlight = null;
    expect(h.archive.syncState(CHANNEL)).toMatchObject({ count: 0, oldestId: null, newestId: null, backfillComplete: false });
    h.archive.setOptIn(CHANNEL, true);
    await h.run();
    expect(h.archive.syncState(CHANNEL)).toMatchObject({ count: FIRST_PAGE });
  });
});

describe('the startup re-check', () => {
  /** Days re-checked: the messages below are inside, ANCIENT outside. */
  const REVERIFY_DAYS = 7;
  const NEWEST = rawMessage(CHANNEL, NOW - MS_PER_MIN, 'newest');
  const OLDER = rawMessage(CHANNEL, NOW - 2 * MS_PER_MIN, 'older');
  const ANCIENT = rawMessage(CHANNEL, NOW - 4 * REVERIFY_DAYS * MS_PER_DAY, 'before the window');
  /** Archives the three, leaves `remaining` on Discord, re-checks at the next start (`during` its requests): which three are now deleted. */
  async function recheck(h: ReturnType<typeof harness>, remaining: RawMessage[], during: typeof h.discord.inFlight = null): Promise<boolean[]> {
    h.messages.set(CHANNEL, [NEWEST, OLDER, ANCIENT]);
    await h.run();
    h.discord.inFlight = during;
    h.messages.set(CHANNEL, remaining);
    h.set({ reverifyChannelIds: [CHANNEL], reverifyDays: REVERIFY_DAYS });
    const done = new Promise<void>((resolve) => { h.sync.onSettled = resolve; });
    await h.sync.syncAll();
    await done;
    const deletedAt = h.db.prepare('SELECT deleted_at AS at FROM messages WHERE id = ?');
    return [NEWEST, OLDER, ANCIENT].map((m) => (deletedAt.get(m.id) as { at: number | null }).at !== null);
  }

  it('marks the newest message deleted while closed, but not one that arrives during the scan', async () => {
    const h = harness({ unit: 'days', amount: 3 });
    const live = rawMessage(CHANNEL, NOW, 'sent during the scan');
    // The scan's first request: the channel's messages, neither after nor before.
    const arrives = (path: string, query: Record<string, unknown>): void => {
      if (path === `channels/${CHANNEL}/messages` && !query['after'] && !query['before']) h.archive.ingestMessages([live], ARRIVAL.gateway);
    };
    expect(await recheck(h, [OLDER, ANCIENT], arrives)).toEqual([true, false, false]);
    expect(h.db.prepare('SELECT deleted_at AS at FROM messages WHERE id = ?').get(live.id)).toEqual({ at: null });
  });

  it('marks the whole window deleted once the channel is empty', async () => {
    const h = harness({ unit: 'days', amount: 3 });
    expect(await recheck(h, [])).toEqual([true, true, false]);
  });
});

describe('a changed depth setting', () => {
  it('names the channels it deepens, by their own choice or the default', () => {
    const base = normalizeArchiveSettings({ backfillHistory: { unit: 'days', amount: 30 }, channelBackfillHistory: { [CHANNEL]: { unit: 'days', amount: 7 } } });
    const ids = [CHANNEL, OTHER];
    const own = normalizeArchiveSettings({ ...base, channelBackfillHistory: { [CHANNEL]: 'complete' } });
    expect(deepenedChannels(base, own, ids, NOW)).toEqual([CHANNEL]);
    expect(deepenedChannels(base, normalizeArchiveSettings({ ...base, backfillHistory: { unit: 'years', amount: 1 } }), ids, NOW)).toEqual([OTHER]);
    expect(deepenedChannels(own, base, ids, NOW)).toEqual([]);
    expect(deepenedChannels(base, normalizeArchiveSettings({ ...base, syncPace: 'normal' }), ids, NOW)).toEqual([]);
  });

  it('is costed from how busy the stored range is', () => {
    const CREATED = NOW - 1000 * MS_PER_DAY;
    // 100 messages over 10 days, 20 more days asked for: 200 messages.
    const stored = { count: 100, oldestMs: NOW - 10 * MS_PER_DAY, newestMs: NOW, backfillComplete: false };
    expect(estimateBackfillPages(stored, NOW - 30 * MS_PER_DAY, CREATED)).toBe(200 / HISTORY_PAGE_SIZE);
    expect(estimateBackfillPages(stored, NOW - 5 * MS_PER_DAY, CREATED)).toBe(0);
    expect(estimateBackfillPages({ ...stored, backfillComplete: true }, NOW - 30 * MS_PER_DAY, CREATED)).toBe(0);
    // A channel can't hold messages older than itself.
    expect(estimateBackfillPages(stored, NOW - 30 * MS_PER_DAY, NOW - 15 * MS_PER_DAY)).toBe(1);
    expect(estimateBackfillPages({ count: 0, oldestMs: null, newestMs: null, backfillComplete: false }, NOW - 30 * MS_PER_DAY, CREATED)).toBeNull();
    expect(estimateBackfillPages({ ...stored, count: 1, oldestMs: NOW }, NOW - 30 * MS_PER_DAY, CREATED)).toBeNull();
  });
});
