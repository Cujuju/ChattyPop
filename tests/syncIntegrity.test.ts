import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RawMessage } from '@shared/discord';
import { MS_PER_DAY, MS_PER_MIN } from '@shared/units';
import { ARRIVAL } from '../src/core/arrival';
import { rawMessage } from './helpers';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));
const { CHANNEL, FIRST_PAGE, NOW, daily, harness } = await import('./syncHarness');
const { followArchiveChanges } = await import('../src/main/sync/depthChange');
type SyncHarness = import('./syncHarness').SyncHarness;

afterEach(() => vi.restoreAllMocks());

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
  async function recheck(h: SyncHarness, remaining: RawMessage[], during: SyncHarness['discord']['inFlight'] = null): Promise<boolean[]> {
    h.messages.set(CHANNEL, [NEWEST, OLDER, ANCIENT]);
    await h.run();
    h.discord.inFlight = during;
    h.messages.set(CHANNEL, remaining);
    h.set({ reverifyChannelIds: [CHANNEL], reverifyDays: REVERIFY_DAYS });
    const done = h.settled();
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

describe('sync turned back on', () => {
  it('fetches the channels a pause skipped, without waiting for another trigger', async () => {
    const h = harness({ unit: 'days', amount: 3 });
    h.messages.set(CHANNEL, daily(CHANNEL));
    followArchiveChanges(h.core as never, h.sync);
    h.set({ syncEnabled: false });
    await h.run();
    expect(h.requests).toEqual([]);
    const done = h.settled();
    h.set({ syncEnabled: true });
    await done;
    expect(h.archive.syncState(CHANNEL)).toMatchObject({ count: FIRST_PAGE });
  });

  it('keeps a channel whose pause check read the setting just before sync was turned on', async () => {
    const h = harness({ unit: 'days', amount: 3 });
    h.messages.set(CHANNEL, daily(CHANNEL));
    followArchiveChanges(h.core as never, h.sync);
    h.set({ syncEnabled: false });
    const call = h.core.call;
    h.core.call = async (method, ...params) => {
      const answer = await call(method, ...params);
      // The pause check's read of the settings comes back (paused) after sync was turned on.
      if (method === 'getSetting') {
        h.core.call = call;
        h.set({ syncEnabled: true });
      }
      return answer;
    };
    const done = h.settled();
    h.sync.enqueue(CHANNEL);
    await done;
    expect(h.archive.syncState(CHANNEL)).toMatchObject({ count: FIRST_PAGE });
  });
});
