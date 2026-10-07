import type { AppEvent } from '@shared/contract';
import { errorMessage } from '@shared/errors';
import { MS_PER_DAY } from '@shared/units';
import {
  CATEGORY_CHANNEL_TYPE,
  DM_GUILD_ID,
  FORUM_CHANNEL_TYPE,
  TEXT_CHANNEL_TYPES,
  THREAD_PARENT_TYPES,
  compareSnowflakes,
  snowflakeToMs,
  type RawChannel,
  type RawGuild,
  type RawMessage,
  type RawThread,
} from '@shared/discord';
import type { ChannelSample } from '@shared/contract';
import type { CoreClient } from '../coreClient';
import { diag } from '../diagnostics';
import type { DiscordApi } from '../discord/api';
import type { DiscordQuery } from '../discord/client';
import type { GatewayDirectory } from '../discord/directory';
import { readArchiveSettings } from './pace';

/** History page size observed from the Discord web client. */
const CLIENT_PAGE_SIZE = 50;
/** Messages sampled per channel for a suggestion: enough to see what a channel is about, one request each. */
const SAMPLE_MESSAGES = 25;
/** Channels sampled per suggestion run: bounds the requests a click makes (at the sync pace, about a minute). */
const SAMPLE_CHANNELS = 20;
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
class SyncStopped extends Error {}

const maxId = (ms: RawMessage[]): string => ms.map((m) => m.id).reduce((a, b) => (compareSnowflakes(a, b) >= 0 ? a : b));
const minId = (ms: RawMessage[]): string => ms.map((m) => m.id).reduce((a, b) => (compareSnowflakes(a, b) <= 0 ? a : b));

/** Catches up opted-in channels, then backfills within depth limits. Discovers threads/forum posts afterward and queues unsynced activity. */
export class SyncService {
  private readonly queue: string[] = [];
  private running = false;
  private halted = false;
  /** Channels still due their startup re-check (Settings → Archive), set by syncAll. */
  private reverifyDue = new Set<string>();
  /** syncAll has run: the session is captured, so requests can go. */
  private started = false;
  /** The account READY last named; its DMs are queued when it changes. */
  private account: string | null = null;
  /** Called each time the queue drains: every queued channel is as current as sync can make it. */
  onSettled: () => void = () => undefined;

  constructor(
    private readonly api: DiscordApi,
    private readonly core: CoreClient,
    private readonly emit: (e: AppEvent) => void,
    private readonly directory: Pick<GatewayDirectory, 'guildList' | 'channelsOf'>,
  ) {}

  /**
   * Recent messages of each channel for a suggestion: up to SAMPLE_MESSAGES per channel, SAMPLE_CHANNELS channels,
   * through the paced API. Channels the account can't read are skipped. Nothing is stored.
   */
  async sampleChannels(channels: { id: string; name: string }[]): Promise<ChannelSample[]> {
    const out: ChannelSample[] = [];
    for (const c of channels.slice(0, SAMPLE_CHANNELS)) {
      try {
        const page = await this.api.get<RawMessage[]>(`channels/${c.id}/messages`, { limit: SAMPLE_MESSAGES });
        const messages = page.filter((m) => m.content).map((m) => ({ author: m.author.global_name || m.author.username, content: m.content }));
        out.push({ channelId: c.id, channelName: c.name, messages: messages.reverse() });
      } catch (err) {
        diag('suggest-sample-skipped', { message: errorMessage(err) });
      }
    }
    return out;
  }

  /** The server list, or one server's channels, as the client's gateway sent them (directory.ts), as is the DM list (privateChannels.ts): no request. */
  async refreshDirectory(guildId?: string): Promise<void> {
    if (!guildId) {
      await this.core.call('upsertGuilds', this.directory.guildList());
      return;
    }
    if (guildId === DM_GUILD_ID) return;
    const channels = this.directory.channelsOf(guildId);
    if (!channels) throw new Error("The live Discord client hasn't loaded this server yet.");
    await this.core.call(
      'upsertChannels',
      guildId,
      channels.filter((c) => TEXT_CHANNEL_TYPES.has(c.type) || c.type === CATEGORY_CHANNEL_TYPE),
    );
  }

  /** Queues every opted-in channel (app start, reconnect). */
  async syncAll(): Promise<void> {
    this.started = true;
    // The signed-in user comes from READY (privateChannels.ts), not a request: it can't lag an account switch.
    this.reverifyDue = new Set((await readArchiveSettings(this.core)).reverifyChannelIds);
    for (const id of await this.core.call('optedInChannels')) this.enqueue(id);
  }

  /** Account changes queue that account’s archived DMs. Other accounts’ queued DMs stop at their next syncability check. */
  async signedIn(userId: string): Promise<void> {
    if (userId === this.account) return;
    this.account = userId;
    if (!this.started) return; // syncAll queues them with the rest
    for (const id of await this.core.call('optedInDms')) this.enqueue(id);
  }

  /** Stops for good (the archive is being moved and the app restarts): the queue is dropped and nothing new starts. */
  halt(): void {
    this.halted = true;
    this.queue.length = 0;
  }

  enqueue(channelId: string): void {
    if (this.halted) return;
    if (!this.queue.includes(channelId)) this.queue.push(channelId);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let ch = this.queue.shift(); ch; ch = this.queue.shift()) {
        try {
          await this.syncChannel(ch);
        } catch (err) {
          this.emit({ type: 'sync-progress', channelId: ch, phase: 'error', fetched: 0, message: errorMessage(err) });
        }
      }
    } finally {
      this.running = false;
    }
    if (!this.halted) this.onSettled();
  }

  private async syncChannel(channelId: string): Promise<void> {
    // Read fresh per channel (not Pace's cache), so pausing sync takes effect at the next channel.
    if (!(await readArchiveSettings(this.core)).syncEnabled) {
      this.emit({ type: 'sync-progress', channelId, phase: 'paused', fetched: 0 });
      return;
    }
    try {
      const kind = (await this.core.call('channelInfo', channelId))?.kind;
      if (kind !== FORUM_CHANNEL_TYPE) {
        await this.syncRange(channelId, `channels/${channelId}/messages`);
        if (this.reverifyDue.delete(channelId)) await this.reverify(channelId);
      }
      this.emit({ type: 'sync-progress', channelId, phase: 'idle', fetched: 0 });
      if (kind !== undefined && THREAD_PARENT_TYPES.has(kind)) {
        for (const id of await this.discoverThreads(channelId)) this.enqueue(id);
      }
    } catch (err) {
      if (!(err instanceof SyncStopped)) throw err;
      this.emit({ type: 'sync-progress', channelId, phase: 'idle', fetched: 0 });
    }
  }

  /** A page of `channelId`'s (or of its threads), sent only while sync still keeps the channel: checked just before it goes. */
  private page<T>(channelId: string, path: string, query: DiscordQuery): Promise<T> {
    const guard = async (): Promise<void> => {
      if (!(await this.core.call('syncable', channelId))) throw new SyncStopped();
    };
    return this.api.get<T>(path, query, { guard });
  }

  /** Stores recent-window threads in client browser order: open, then archived, newest activity first. Returns threads needing message sync. */
  private async discoverThreads(channelId: string): Promise<string[]> {
    const { backfillDays } = await readArchiveSettings(this.core);
    const cutoffMs = Date.now() - backfillDays * MS_PER_DAY;
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
          if (!page.has_more || recent.length < page.threads.length) break;
        }
      } catch (err) {
        if (err instanceof SyncStopped) throw err;
        // A channel without thread access (or a changed endpoint) must not stop its messages from syncing.
        diag('thread-discovery-failed', { archived, message: errorMessage(err) });
      }
    }
    return stale;
  }

  /** Refetches the last N days newest first at startup. Changed content becomes revisions; missing stored messages inside the fetched window become deleted. */
  private async reverify(channelId: string): Promise<void> {
    const { reverifyDays } = await readArchiveSettings(this.core);
    const cutoffMs = Date.now() - reverifyDays * MS_PER_DAY;
    const seen: string[] = [];
    let oldest: string | null = null;
    let newest: string | null = null;
    for (let before: string | undefined; ;) {
      const page = await this.page<RawMessage[]>(channelId, `channels/${channelId}/messages`, { limit: CLIENT_PAGE_SIZE, before });
      if (!page.length) break;
      await this.core.call('ingestMessages', page);
      seen.push(...page.map((m) => m.id));
      newest ??= maxId(page);
      oldest = minId(page);
      this.emit({ type: 'sync-progress', channelId, phase: 'reverify', fetched: seen.length });
      if (page.length < CLIENT_PAGE_SIZE || snowflakeToMs(oldest) < cutoffMs) break;
      before = oldest;
    }
    // Only the window the pages covered without gaps: from the oldest fetched message to the newest.
    if (oldest && newest) await this.core.call('reconcileDeletes', channelId, seen, snowflakeToMs(oldest), snowflakeToMs(newest));
  }

  private async syncRange(channelId: string, path: string): Promise<void> {
    const state = await this.core.call('syncState', channelId);
    let fetched = 0;

    // Catch up: everything newer than the synced range (or the latest page for a never-synced channel).
    for (let after = state.newestId; ;) {
      const page = await this.page<RawMessage[]>(channelId, path, { limit: CLIENT_PAGE_SIZE, after: after ?? undefined });
      const reachedEnd = page.length < CLIENT_PAGE_SIZE;
      await this.core.call('ingestSyncPage', channelId, page, after ? 'newer' : 'older', !after && reachedEnd);
      fetched += page.length;
      this.emit({ type: 'sync-progress', channelId, phase: 'catch-up', fetched });
      if (!after || reachedEnd) break;
      after = maxId(page);
    }

    const { backfillDays } = await readArchiveSettings(this.core);
    const cutoffMs = Date.now() - backfillDays * MS_PER_DAY;
    const synced = await this.core.call('syncState', channelId);
    if (synced.backfillComplete) return;
    for (let before = synced.oldestId; before && snowflakeToMs(before) > cutoffMs;) {
      const page = await this.page<RawMessage[]>(channelId, path, { limit: CLIENT_PAGE_SIZE, before });
      const reachedEnd = page.length < CLIENT_PAGE_SIZE;
      await this.core.call('ingestSyncPage', channelId, page, 'older', reachedEnd);
      fetched += page.length;
      this.emit({ type: 'sync-progress', channelId, phase: 'backfill', fetched });
      if (reachedEnd) return;
      before = minId(page);
    }
  }
}
