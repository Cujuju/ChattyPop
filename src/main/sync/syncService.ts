import type { AppEvent } from '@shared/contract';
import { errorMessage } from '@shared/errors';
import { CATEGORY_CHANNEL_TYPE, DM_GUILD_ID, FORUM_CHANNEL_TYPE, TEXT_CHANNEL_TYPES, THREAD_PARENT_TYPES, type RawMessage } from '@shared/discord';
import type { ChannelSample } from '@shared/contract';
import type { CoreClient } from '../coreClient';
import { diag } from '../diagnostics';
import type { DiscordApi } from '../discord/api';
import type { GatewayDirectory } from '../discord/directory';
import { ChannelHistory, SyncStopped } from './channelHistory';
import { HistoryReaches, shortOf, type HistoryResult } from './historyReach';
import { readArchiveSettings } from './pace';

/** Messages sampled per channel for a suggestion: enough to see what a channel is about, one request each. */
const SAMPLE_MESSAGES = 25;
/** Channels sampled per suggestion run: bounds the requests a click makes (at the sync pace, about a minute). */
const SAMPLE_CHANNELS = 20;

/** How a channel's sync ended without failing: done, sync paused before it, or the channel no longer kept. */
type SyncEnd = 'synced' | 'paused' | 'stopped';

/** Catches up opted-in channels, then backfills within depth limits. Discovers threads/forum posts afterward and queues unsynced activity. */
export class SyncService {
  private readonly queue: string[] = [];
  private running = false;
  private halted = false;
  /** Channels still due their startup re-check (Settings → Archive), set by syncAll. */
  private reverifyDue = new Set<string>();
  /** syncAll has run: the session is captured, so requests can go. */
  private started = false;
  /** History someone waits for beyond a channel's depth setting (historyTo). */
  private readonly reaches = new HistoryReaches();
  /** Channels sync reached while paused and dropped from the queue: resume queues them again. */
  private readonly paused = new Set<string>();
  /** Counts resumes, so a pause check that read the setting before one doesn't drop its channel. */
  private resumes = 0;
  /** Called each time the queue drains: every queued channel is as current as sync can make it. */
  onSettled: () => void = () => undefined;
  private readonly history: ChannelHistory;

  constructor(
    private readonly api: DiscordApi,
    private readonly core: CoreClient,
    private readonly emit: (e: AppEvent) => void,
    private readonly directory: Pick<GatewayDirectory, 'guildList' | 'channelsOf'>,
  ) {
    this.history = new ChannelHistory(api, core, emit, this.reaches);
  }

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

  /**
   * A new gateway session (READY, same account or not): what was sent while none was connected never arrives live, so every
   * kept channel catches up, the account's DMs among them. Other accounts' queued DMs stop at their next syncability check.
   */
  async sessionReady(): Promise<void> {
    if (!this.started) return; // syncAll queues them all
    for (const id of await this.core.call('optedInChannels')) this.enqueue(id);
  }

  /** Stops for good (the archive is being moved and the app restarts): the queue is dropped and nothing new starts. */
  halt(): void {
    this.halted = true;
    this.queue.length = 0;
    this.paused.clear();
    this.reaches.stopAll();
  }

  /** Sync is on (Settings → Archive): queues the channels a pause dropped. */
  resume(): void {
    this.resumes++;
    const ids = [...this.paused];
    this.paused.clear();
    ids.forEach((id) => this.enqueue(id));
  }

  /** Fetches each channel's history back to `sinceMs` (its threads' too), past a shallower depth setting, and answers once each has ended. Settings are untouched. */
  historyTo(channelIds: readonly string[], sinceMs: number): Promise<HistoryResult[]> {
    const ids = [...new Set(channelIds)];
    if (this.halted) return Promise.resolve(ids.map((channelId) => ({ channelId, outcome: 'stopped' as const })));
    const waits = ids.map((id) => this.reaches.ask(id, sinceMs));
    ids.forEach((id) => this.enqueue(id));
    return Promise.all(waits);
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
        let end: SyncEnd | { failure: string };
        try {
          end = await this.syncChannel(ch);
        } catch (err) {
          end = { failure: errorMessage(err) };
          this.emit({ type: 'sync-progress', channelId: ch, phase: 'error', fetched: 0, message: end.failure });
        }
        await this.settleReach(ch, end).catch((err: unknown) => this.reaches.done(ch, 'failed', errorMessage(err)));
      }
    } finally {
      this.running = false;
    }
    if (!this.halted) this.onSettled();
  }

  /** Ends `channelId`'s part of a wait for history once its sync has, unless it is queued again. */
  private async settleReach(channelId: string, end: SyncEnd | { failure: string }): Promise<void> {
    if (this.reaches.sinceMs(channelId) === undefined) return;
    const state = await this.core.call('syncState', channelId);
    const kind = (await this.core.call('channelInfo', channelId))?.kind;
    // Read after the awaits: a second ask may have deepened the wait or queued the channel meanwhile.
    const sinceMs = this.reaches.sinceMs(channelId);
    if (sinceMs === undefined || this.queue.includes(channelId)) return;
    if (typeof end === 'object') return this.reaches.done(channelId, 'failed', end.failure);
    // A forum holds no messages of its own: its posts are the threads this wait covers, listed only by a sync that ran.
    const reached = kind === FORUM_CHANNEL_TYPE ? end === 'synced' : !shortOf(state, sinceMs);
    this.reaches.done(channelId, reached ? 'reached' : 'stopped');
  }

  private async syncChannel(channelId: string): Promise<SyncEnd> {
    // Read fresh per channel (not Pace's cache), so pausing sync takes effect at the next channel.
    const resumes = this.resumes;
    if (!(await readArchiveSettings(this.core)).syncEnabled) {
      this.paused.add(channelId);
      // Turned back on while the setting was read: that resume missed this channel.
      if (resumes !== this.resumes) this.resume();
      this.emit({ type: 'sync-progress', channelId, phase: 'paused', fetched: 0 });
      return 'paused';
    }
    try {
      const kind = (await this.core.call('channelInfo', channelId))?.kind;
      if (kind !== FORUM_CHANNEL_TYPE) {
        await this.history.syncRange(channelId, `channels/${channelId}/messages`);
        if (this.reverifyDue.delete(channelId)) await this.history.reverify(channelId);
      }
      this.emit({ type: 'sync-progress', channelId, phase: 'idle', fetched: 0 });
      if (kind !== undefined && THREAD_PARENT_TYPES.has(kind)) {
        for (const id of await this.history.discoverThreads(channelId)) this.enqueue(id);
      }
      return 'synced';
    } catch (err) {
      if (!(err instanceof SyncStopped)) throw err;
      this.emit({ type: 'sync-progress', channelId, phase: 'idle', fetched: 0 });
      return 'stopped';
    }
  }
}
