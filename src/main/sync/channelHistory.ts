// One channel's history fetches: catch-up, backfill, startup re-check and thread discovery.
import type { AppEvent, ChannelInfo } from '@shared/contract';
import { errorMessage } from '@shared/errors';
import { resolveBackfillCutoffMs, type ArchiveSettings } from '@shared/archiveSettings';
import { HISTORY_PAGE_SIZE } from '@shared/backfillProgress';
import { MS_PER_DAY } from '@shared/units';
import { compareSnowflakes, snowflakeFromMs, snowflakeToMs, type RawMessage, type RawThread } from '@shared/discord';
import type { CoreClient } from '../coreClient';
import { diag } from '../diagnostics';
import type { DiscordApi } from '../discord/api';
import type { DiscordQuery } from '../discord/client';
import { shortOf, type HistoryReaches } from './historyReach';
import { readArchiveSettings } from './pace';

/** Page size the Discord web client uses for its thread browser and forum lists. */
const THREAD_SEARCH_PAGE_SIZE = 25;

/** channels/{id}/threads/search response (user accounts can't use the bot-only thread list endpoints). */
interface ThreadSearchPage {
  threads: RawThread[];
  has_more: boolean;
}

/** Newest activity in a thread: its last message, else its creation (the id is a snowflake). */
const lastActivityMs = (t: RawThread): number => snowflakeToMs(t.last_message_id ?? t.id);

/** A channel sync stopped keeping while queued or mid-sync: archiving stopped, another account signed in, or a group left. */
export class SyncStopped extends Error {}

const maxId = (ms: RawMessage[]): string => ms.map((m) => m.id).reduce((a, b) => (compareSnowflakes(a, b) >= 0 ? a : b));
const minId = (ms: RawMessage[]): string => ms.map((m) => m.id).reduce((a, b) => (compareSnowflakes(a, b) <= 0 ? a : b));

/** Fetches one channel's messages and threads through the paced API while sync still keeps it; a stop throws SyncStopped. */
export class ChannelHistory {
  constructor(
    private readonly api: DiscordApi,
    private readonly core: CoreClient,
    private readonly emit: (e: AppEvent) => void,
    private readonly reaches: HistoryReaches,
  ) {}

  /** How far back `channelId` is fetched: its depth setting, or further while someone waits for more. */
  private cutoffMs(settings: ArchiveSettings, channelId: string, channel?: Pick<ChannelInfo, 'kind' | 'parentId'> | null): number {
    return Math.min(resolveBackfillCutoffMs(settings, channelId, Date.now(), channel), this.reaches.sinceMs(channelId) ?? Infinity);
  }

  /** A page of `channelId`'s (or of its threads), sent only while sync still keeps the channel: checked just before it goes. */
  private page<T>(channelId: string, path: string, query: DiscordQuery): Promise<T> {
    const guard = async (): Promise<void> => {
      if (!(await this.core.call('syncable', channelId))) throw new SyncStopped();
    };
    return this.api.get<T>(path, query, { guard });
  }

  /** Stores a fetched page and moves the cursors over it, unless sync stopped keeping the channel while it was fetched. */
  private async store(channelId: string, page: RawMessage[], direction: 'newer' | 'older', reachedEnd: boolean): Promise<void> {
    if (!(await this.core.call('ingestSyncPage', channelId, page, direction, reachedEnd))) throw new SyncStopped();
  }

  /** Stores recent-window threads in client browser order: open, then archived, newest activity first. Returns threads needing message sync, which a wait for the channel covers. */
  async discoverThreads(channelId: string): Promise<string[]> {
    const settings = await readArchiveSettings(this.core);
    const cutoffMs = this.cutoffMs(settings, channelId);
    const waitedMs = this.reaches.sinceMs(channelId);
    const stale: string[] = [];
    for (const archived of [false, true]) {
      try {
        for (let offset = 0; ; offset += THREAD_SEARCH_PAGE_SIZE) {
          const page = await this.page<ThreadSearchPage>(channelId, `channels/${channelId}/threads/search`, {
            archived: String(archived),
            sort_by: 'last_message_time',
            sort_order: 'desc',
            limit: THREAD_SEARCH_PAGE_SIZE,
            offset,
          });
          const recent = page.threads.filter((t) => lastActivityMs(t) >= cutoffMs);
          stale.push(...(await this.core.call('upsertThreads', recent)));
          // Core answers by the depth setting; a wait reaching past it needs the threads short of its own time too.
          if (waitedMs !== undefined) {
            for (const t of recent) {
              if (t.last_message_id && !stale.includes(t.id) && shortOf(await this.core.call('syncState', t.id), waitedMs)) stale.push(t.id);
            }
          }
          if (!page.has_more || recent.length < page.threads.length) break;
        }
      } catch (err) {
        if (err instanceof SyncStopped) throw err;
        // A channel without thread access (or a changed endpoint) must not stop its messages from syncing; a wait for it hears.
        diag('thread-discovery-failed', { archived, message: errorMessage(err) });
        this.reaches.note(channelId, 'failed', `Its threads couldn't be listed: ${errorMessage(err)}`);
      }
    }
    this.reaches.include(channelId, stale);
    return stale;
  }

  /** Refetches the last N days newest first at startup. Changed content becomes revisions; missing stored messages inside the fetched window become deleted. */
  async reverify(channelId: string): Promise<void> {
    const { reverifyDays } = await readArchiveSettings(this.core);
    const cutoffMs = Date.now() - reverifyDays * MS_PER_DAY;
    // Stored before the first request, so it existed by then: the scan from the latest page returns it unless it was deleted.
    // Messages arriving during the scan sort after it and stay out.
    const throughId = await this.core.call('newestStoredId', channelId);
    const seen: string[] = [];
    let oldest: string | null = null;
    for (let before: string | undefined; ;) {
      const page = await this.page<RawMessage[]>(channelId, `channels/${channelId}/messages`, { limit: HISTORY_PAGE_SIZE, before });
      if (page.length) {
        await this.core.call('ingestMessages', page);
        seen.push(...page.map((m) => m.id));
        oldest = minId(page);
        this.emit({ type: 'sync-progress', channelId, phase: 'reverify', fetched: seen.length });
      }
      if (page.length < HISTORY_PAGE_SIZE) break;
      before = minId(page);
      if (snowflakeToMs(before) < cutoffMs) break;
    }
    if (!throughId) return;
    // Covered without gaps: back to the oldest fetched, or the whole window once a short page showed nothing older exists.
    const windowStart = snowflakeFromMs(cutoffMs);
    const fromId = oldest && compareSnowflakes(oldest, windowStart) < 0 ? oldest : windowStart;
    await this.core.call('reconcileDeletes', channelId, seen, fromId, throughId);
  }

  async syncRange(channelId: string, path: string): Promise<void> {
    const settings = await readArchiveSettings(this.core);
    const channel = await this.core.call('channelInfo', channelId);
    const cutoffMs = this.cutoffMs(settings, channelId, channel);
    const state = await this.core.call('syncState', channelId);
    let fetched = 0;

    // Catch up: everything newer than the synced range (or the latest page for a never-synced channel).
    for (let after = state.newestId; ;) {
      const page = await this.page<RawMessage[]>(channelId, path, { limit: HISTORY_PAGE_SIZE, after: after ?? undefined });
      const reachedEnd = page.length < HISTORY_PAGE_SIZE;
      await this.store(channelId, page, after ? 'newer' : 'older', !after && reachedEnd);
      fetched += page.length;
      this.emit({ type: 'sync-progress', channelId, phase: 'catch-up', fetched });
      if (!after || reachedEnd) break;
      after = maxId(page);
    }

    // The cutoff bounds how far back pages are fetched (through its own millisecond); a fetched page is stored whole.
    const synced = await this.core.call('syncState', channelId);
    if (synced.backfillComplete) return;
    for (let before = synced.oldestId; before && snowflakeToMs(before) >= cutoffMs;) {
      const page = await this.page<RawMessage[]>(channelId, path, { limit: HISTORY_PAGE_SIZE, before });
      const reachedEnd = page.length < HISTORY_PAGE_SIZE;
      await this.store(channelId, page, 'older', reachedEnd);
      fetched += page.length;
      this.emit({ type: 'sync-progress', channelId, phase: 'backfill', fetched });
      if (reachedEnd) return;
      before = minId(page);
    }
  }
}
