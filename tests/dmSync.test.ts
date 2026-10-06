// Syncs only the signed-in account’s eligible archived DMs after READY. Losing archive access stops queued or active sync. Requests and departed groups cannot be archived.
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '@shared/contract';
import { DM_CHANNEL_TYPE, GROUP_DM_CHANNEL_TYPE, type RawMessage } from '@shared/discord';
import { MS_PER_S } from '@shared/units';
import { BOB, DM, GROUP, GUILD_CHANNEL, NEW, SELF, dmArchive } from './dmFixtures';
import { rawMessage } from './helpers';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));

const { SyncService } = await import('../src/main/sync/syncService');

const OTHER = '900000000000000002';
/** A DM an older build stored, claimed by no account. */
const LEGACY = '400000000000000009';
const REQUEST = '400000000000000008';
/** A full page: sync asks for the next. */
const PAGE = 50;

let h: ReturnType<typeof dmArchive>;
beforeEach(() => {
  h = dmArchive();
  h.a.upsertPrivateChannel(OTHER, { id: NEW, type: DM_CHANNEL_TYPE, recipients: [BOB] }, true);
  h.a.upsertPrivateChannel(null, { id: LEGACY, type: DM_CHANNEL_TYPE, recipients: [BOB] }, true);
  for (const id of [DM, GROUP, NEW, LEGACY]) h.a.setOptIn(id, true);
});
const sorted = async (method: 'optedInChannels' | 'optedInDms'): Promise<string[]> => ((await h.call(method)) as string[]).sort();
const leave = (id: string): unknown => h.call('applyGatewayEvent', 'CHANNEL_DELETE', { id, type: GROUP_DM_CHANNEL_TYPE });

describe('what sync keeps', () => {
  it("the signed-in account's archived DMs only, never a group left; no DM before READY names the account", async () => {
    expect(await sorted('optedInChannels')).toEqual([GUILD_CHANNEL, DM, GROUP].sort());
    expect(await sorted('optedInDms')).toEqual([DM, GROUP].sort());
    expect(await h.call('syncable', NEW)).toBe(false);
    expect(await h.call('syncable', LEGACY)).toBe(false);
    await leave(GROUP);
    expect(await sorted('optedInDms')).toEqual([DM]);
    expect(await h.call('syncable', GROUP)).toBe(false);
    h.signIn(OTHER);
    expect(await sorted('optedInChannels')).toEqual([GUILD_CHANNEL, NEW].sort());
    h.signIn(null);
    expect(await sorted('optedInChannels')).toEqual([GUILD_CHANNEL]);
  });

  it("archiving refuses a message request, a group left and another account's DM; stopping always works", async () => {
    h.a.upsertPrivateChannel(SELF, { id: REQUEST, type: DM_CHANNEL_TYPE, recipients: [BOB], is_message_request: true }, true);
    await expect(h.call('setOptIn', REQUEST, true)).rejects.toThrow('message request');
    await leave(GROUP);
    await h.call('setOptIn', GROUP, false);
    await expect(h.call('setOptIn', GROUP, true)).rejects.toThrow('You left this group');
    await expect(h.call('setOptIn', NEW, true)).rejects.toThrow('Not a direct message of the account signed in.');
    await h.call('setOptIn', GUILD_CHANNEL, true);
  });
});

/** Sync over the test core, its pages from `pages` (each request after its guard passes); records what was sent. */
function syncOver(pages: (path: string) => RawMessage[] = () => []) {
  const sent: string[] = [];
  const api = {
    get: async (path: string, _query: unknown, opts?: { guard?: () => void | Promise<void> }) => {
      await opts?.guard?.();
      sent.push(path);
      return path.endsWith('/threads/search') ? { threads: [], has_more: false } : pages(path);
    },
  };
  // Settings left unset read as their defaults.
  const core = { call: (m: string, ...p: unknown[]) => (m === 'getSetting' ? Promise.resolve(undefined) : h.call(m as never, ...p)) };
  const events: AppEvent[] = [];
  const sync = new SyncService(api as never, core as never, (e) => void events.push(e));
  const settled = (): Promise<void> => new Promise((resolve) => (sync.onSettled = resolve));
  return { sync, sent, events, settled };
}
const sentFor = (sent: string[], id: string): string[] => sent.filter((p) => p.includes(id));

describe('sync', () => {
  it("stops a queued DM once another account signs in, then queues that account's archived DMs", async () => {
    const { sync, sent, settled } = syncOver();
    await sync.signedIn(SELF);
    let done = settled();
    await sync.syncAll();
    // READY for another account lands while the account's first channel syncs.
    h.signIn(OTHER);
    await done;
    expect([sentFor(sent, DM), sentFor(sent, GROUP), sentFor(sent, NEW)]).toEqual([[], [], []]);
    done = settled();
    await sync.signedIn(OTHER);
    await done;
    expect(sentFor(sent, NEW)).toHaveLength(1);
    expect(sentFor(sent, LEGACY)).toEqual([]);
  });

  it('a group left mid-sync gets no further page, and reports no error', async () => {
    const now = Date.now();
    const page = Array.from({ length: PAGE }, (_, i) => rawMessage(GROUP, now - i * MS_PER_S, 'hi'));
    const { sync, sent, events, settled } = syncOver((path) => {
      if (!path.includes(GROUP)) return [];
      void leave(GROUP);
      return page;
    });
    const done = settled();
    sync.enqueue(GROUP);
    await done;
    expect(sentFor(sent, GROUP)).toHaveLength(1);
    expect(events.filter((e) => e.type === 'sync-progress' && e.phase === 'error')).toEqual([]);
  });
});
