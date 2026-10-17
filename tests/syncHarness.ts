// SyncService over a real archive and a fake Discord history. Test files mock 'electron' before importing this.
import { expect, vi } from 'vitest';
import type { AppEvent } from '@shared/contract';
import { normalizeArchiveSettings, resolveBackfillCutoffMs, type ArchiveSettings, type ChannelBackfillHistory } from '@shared/archiveSettings';
import { HISTORY_PAGE_SIZE } from '@shared/backfillProgress';
import { compareSnowflakes, type RawMessage, type RawThread } from '@shared/discord';
import { SETTINGS_KEYS } from '@shared/settings';
import { MS_PER_DAY } from '@shared/units';
import { archiveHandlers } from '../src/core/archiveHandlers';
import { SyncService } from '../src/main/sync/syncService';
import { seedArchive, tempDb, rawMessage } from './helpers';

export const NOW = Date.parse('2026-10-12T12:00:00Z');
export const CHANNEL = '200000000000000001';
export const OTHER = '200000000000000002';
export const THREAD = '300000000000000001';
export const OTHER_THREAD = '300000000000000002';
export const SELF = '900000000000000001';
/** Enough history to require multiple Discord message pages. */
export const HISTORY_MESSAGES = 120;
/** A first sync stores the latest page whole, whatever the cutoff. */
export const FIRST_PAGE = HISTORY_PAGE_SIZE;

/** One message a day back from NOW, newest first: message i is i + `firstDay` days old. */
export const daily = (channelId: string, firstDay = 1): RawMessage[] =>
  Array.from({ length: HISTORY_MESSAGES }, (_, i) => rawMessage(channelId, NOW - (i + firstDay) * MS_PER_DAY, `message ${i}`));

export type SyncHarness = ReturnType<typeof harness>;

export function harness(choice: ChannelBackfillHistory) {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  const db = tempDb();
  const archive = seedArchive(db, [{ id: CHANNEL }, { id: OTHER }]);
  let settings = normalizeArchiveSettings({ backfillHistory: { unit: 'days', amount: 1 }, channelBackfillHistory: { [CHANNEL]: choice } });
  const messages = new Map<string, RawMessage[]>();
  const threads = new Map<string, RawThread[]>();
  const events: AppEvent[] = [];
  const listeners: ((e: AppEvent) => void)[] = [];
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
    on: (_: 'event', listener: (e: AppEvent) => void) => void listeners.push(listener),
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
  /** Resolves when the queue next drains. */
  const settled = () => new Promise<void>((resolve) => { sync.onSettled = resolve; });
  const run = async (id = CHANNEL) => {
    const done = settled();
    sync.enqueue(id);
    await done;
    expect(events.filter((e) => e.type === 'sync-progress' && e.phase === 'error')).toEqual([]);
  };
  /** Changes the archive settings as core does: stored, then announced. */
  const set = (patch: Partial<ArchiveSettings>) => {
    settings = normalizeArchiveSettings({ ...settings, ...patch });
    for (const listener of listeners) listener({ type: 'setting-changed', key: SETTINGS_KEYS.archive, value: settings });
  };
  const choose = (id: string, history: ChannelBackfillHistory) => set({ channelBackfillHistory: { ...settings.channelBackfillHistory, [id]: history } });
  return { db, archive, core, messages, threads, requests, discord, sync, run, settled, set, choose, settings: () => settings };
}
