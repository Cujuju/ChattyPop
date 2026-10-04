// Discord's read states (docs.discord.food → Read State): each channel's last read message and unread mention count, as
// Discord's own client keeps them from its gateway traffic, and acknowledging a channel read from ChattyPop.
import type { ReadStateCount, ReadStateScope } from '@shared/contract';
import { DM_CHANNEL_TYPES, MUTED_FOREVER, compareSnowflakes } from '@shared/discord';
import type { DiscordApi } from './api';
import type { GatewayTap } from './gatewayTap';
import { entriesOf } from './readyLists';

/** Read state type of channel message unreads; other types (events, onboarding) aren't channels. */
const CHANNEL_READ_STATE = 0;
/** Message types that never count in a DM (a member removed) or never reset it when the owner sent them (a poll's result). */
const RECIPIENT_REMOVE_MESSAGE = 2;
const POLL_RESULT_MESSAGE = 46;

interface RawReadState {
  id: string;
  read_state_type?: number;
  last_message_id?: string | null;
  mention_count?: number;
}

interface RawMute {
  muted?: boolean;
  mute_config?: { end_time?: string | null } | null;
}

interface RawGuildSettings extends RawMute {
  guild_id: string | null;
  suppress_everyone?: boolean;
  suppress_roles?: boolean;
  channel_overrides?: (RawMute & { channel_id: string })[];
}

/** What decides whether a new message pings the owner. */
export interface PingMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  type?: number;
  author?: { id: string };
  mentions?: { id: string }[];
  mention_roles?: string[];
  mention_everyone?: boolean;
}

/** When a mute ends (ms; MUTED_FOREVER without an end); null when not muted or its end can't be read. */
const muteEndsMs = (m: RawMute | undefined): number | null => {
  if (m?.muted !== true) return null;
  const end = m.mute_config?.end_time;
  if (!end) return MUTED_FOREVER;
  const ms = Date.parse(end);
  return Number.isNaN(ms) ? null : ms;
};

const mutedNow = (m: RawMute, now: number): boolean => {
  const end = muteEndsMs(m);
  return end !== null && end > now;
};

interface ReadState {
  /** The last acknowledged message (ours while an ack is sending); null when the channel was never read; absent while unknown. */
  ackId?: string | null;
  /** Mentions whose messages aren't known (READY's or a MESSAGE_ACK's count): taken to be at or before any later ack. */
  counted: number;
  /** Messages this session that pinged the owner, newer than `ackId`. */
  pings: string[];
}


const mentionsOf = (s: ReadState): number => s.counted + s.pings.length;
const UNREAD: ReadState = { counted: 0, pings: [] };

/**
 * Each channel's unread mention count, kept as Discord's client keeps it: READY's read states, then +1 for each new
 * message that pings the owner (Discord's rule: a user, role or everyone mention not suppressed; every message in an
 * unmuted DM), reset by a read anywhere (MESSAGE_ACK) or the owner's own message. A DM's count also carries its last
 * read message and mute end.
 * Residual: a server set to notify on all messages with "mention on all messages" counts every message on Discord, not here.
 */
export class ReadStates {
  private self: string | null = null;
  /** A MESSAGE_ACK's field names were noted this session (they are undocumented). */
  private ackSeen = false;
  private readonly states = new Map<string, ReadState>();
  /** Discord's state from before an ack of ours, by channel, while it is sending: a failure returns to it. */
  private readonly rollbacks = new Map<string, ReadState>();
  /** Channels with an ack in flight, each with the newer message to ack once it lands (null: none). */
  private readonly sending = new Map<string, string | null>();
  /** The owner's roles, by server. */
  private readonly roles = new Map<string, Set<string>>();
  /** The owner's notification settings, by server ('' = DMs). */
  private readonly settings = new Map<string, RawGuildSettings>();
  /** DMs and group DMs this session has seen: their counts carry read and mute state. */
  private readonly dms = new Set<string>();
  /** A full settings list arrived for this account: a DM without an override is known unmuted. */
  private settingsFull = false;

  /** Subscribe before the client opens its socket (as the tap requires), or READY is missed. */
  constructor(
    tap: GatewayTap,
    private readonly api: Pick<DiscordApi, 'post'>,
    /** Counts changed; `scope`: merged, or every channel's (READY), others dropping to zero ('reset': a new account's). */
    private readonly onCounts: (counts: ReadStateCount[], scope: ReadStateScope) => void,
    /** Session-health notes (diagnostics.log): counts and field names only, never ids or content. */
    private readonly diag: (event: string, data: Record<string, unknown>) => void,
    private readonly now: () => number = Date.now,
  ) {
    tap.on('dispatch', ({ t, d }) => this.apply(t, d));
  }

  /**
   * Marks `channelId` read up to `messageId` on Discord, as its client does when the channel is viewed. Shown at once:
   * pings after it keep counting. One ack per channel is in flight; newer ones coalesce into the next. A failure returns
   * to Discord's state, with the pings that came meanwhile.
   */
  ack(channelId: string, messageId: string): void {
    const before = this.states.get(channelId) ?? UNREAD;
    if (before.ackId && compareSnowflakes(messageId, before.ackId) <= 0) return;
    if (!this.rollbacks.has(channelId)) this.rollbacks.set(channelId, before);
    this.put(channelId, { ackId: messageId, counted: 0, pings: before.pings.filter((id) => compareSnowflakes(id, messageId) > 0) });
    if (this.sending.has(channelId)) {
      this.sending.set(channelId, messageId);
      return;
    }
    void this.send(channelId, messageId, this.self);
  }

  private async send(channelId: string, messageId: string, self: string | null): Promise<void> {
    this.sending.set(channelId, null);
    try {
      // token: the old ack token, which Discord's read state service ignores and answers null. The guard keeps an ack
      // from going out after another account signed in.
      await this.api.post(`channels/${channelId}/messages/${messageId}/ack`, { token: null }, {
        guard: () => {
          if (this.self !== self) throw new Error('Another Discord account signed in.');
        },
      });
    } catch (err) {
      this.diag('read-state-ack-failed', { message: err instanceof Error ? err.message : String(err) });
      const back = this.rollbacks.get(channelId);
      // A newer ack queued covers this one; with none, Discord's state stands.
      if (!this.sending.get(channelId) && back && self === this.self) {
        this.rollbacks.delete(channelId);
        this.put(channelId, back);
      }
    }
    const next = this.sending.get(channelId);
    if (next && self === this.self) return this.send(channelId, next, self);
    this.sending.delete(channelId);
    this.rollbacks.delete(channelId);
  }

  /** Discord's answer to a settings write (a DM mute): applied as the gateway's update for it, which may come later. */
  settingsChanged(settings: unknown): void {
    const s = settings as Partial<RawGuildSettings> | null;
    if (s && Array.isArray(s.channel_overrides)) this.apply('USER_GUILD_SETTINGS_UPDATE', { ...s, guild_id: s.guild_id ?? null });
  }

  private apply(t: string, d: unknown): void {
    switch (t) {
      case 'READY':
        return this.ready(d as Record<string, unknown>);
      // Newer clients get the owner's members here, after READY.
      case 'READY_SUPPLEMENTAL':
        return this.ownRoles(d as Record<string, unknown>);
      case 'GUILD_CREATE': {
        const g = d as { id: string; members?: { user?: { id: string }; roles?: string[] }[] };
        const me = g.members?.find((m) => m.user?.id === this.self);
        if (me?.roles) this.roles.set(g.id, new Set(me.roles));
        return;
      }
      case 'GUILD_MEMBER_UPDATE': {
        const m = d as { guild_id: string; user?: { id: string }; roles?: string[] };
        if (m.user?.id === this.self && m.roles) this.roles.set(m.guild_id, new Set(m.roles));
        return;
      }
      case 'USER_GUILD_SETTINGS_UPDATE': {
        const updates = (Array.isArray(d) ? d : [d]) as RawGuildSettings[];
        for (const s of updates) this.settings.set(s.guild_id ?? '', s);
        // DM overrides changed: every DM's mute is sent again, so a dropped override unmutes it.
        if (updates.some((s) => !s.guild_id)) this.onCounts([...this.dms].map((id) => this.count(id)), 'merge');
        return;
      }
      case 'CHANNEL_CREATE': {
        const c = d as { id: string; type: number };
        if (!DM_CHANNEL_TYPES.has(c.type)) return;
        // A DM (re)opened: its read state and mute, cached since READY, reach core now.
        this.dms.add(c.id);
        this.onCounts([this.count(c.id)], 'merge');
        return;
      }
      case 'MESSAGE_ACK': {
        const a = d as { channel_id: string; message_id: string; mention_count?: number };
        if (!this.ackSeen) this.diag('read-state-ack-fields', { fields: Object.keys(a) });
        this.ackSeen = true;
        this.confirm(a.channel_id, { ackId: a.message_id, counted: typeof a.mention_count === 'number' ? a.mention_count : 0, pings: [] });
        return;
      }
      case 'MESSAGE_CREATE': {
        const m = d as PingMessage;
        if (!m.guild_id) this.dms.add(m.channel_id);
        return this.message(m);
      }
    }
  }

  /**
   * A READY for another account drops everything cached for the last one. Otherwise a partial (or absent) list merges:
   * what it leaves out keeps its cached value.
   */
  private ready(d: Record<string, unknown>): void {
    const self = (d['user'] as { id: string } | undefined)?.id ?? null;
    const switched = this.self !== null && self !== this.self;
    if (switched) {
      this.states.clear();
      this.settings.clear();
      this.dms.clear();
      this.settingsFull = false;
    }
    this.self = self;
    this.roles.clear();
    this.ownRoles(d);

    const settings = entriesOf<RawGuildSettings>(d['user_guild_settings']);
    if (!settings.partial) {
      this.settings.clear();
      this.settingsFull = true;
    }
    for (const s of settings.entries) this.settings.set(s.guild_id ?? '', s);
    const privateChannels = entriesOf<{ id: string }>(d['private_channels']);
    if (!privateChannels.partial) this.dms.clear();
    for (const c of privateChannels.entries) this.dms.add(c.id);
    const { entries, partial } = entriesOf<RawReadState>(d['read_state']);
    const cached = new Map(this.states);
    if (!partial) this.states.clear();
    this.rollbacks.clear();
    for (const r of entries) {
      if ((r.read_state_type ?? CHANNEL_READ_STATE) !== CHANNEL_READ_STATE) continue;
      // A field an entry leaves out keeps what was cached for it.
      const was = cached.get(r.id);
      const ackId = 'last_message_id' in r ? (r.last_message_id ?? null) : was?.ackId;
      this.states.set(r.id, {
        ...(ackId !== undefined ? { ackId } : {}),
        ...(typeof r.mention_count === 'number' ? { counted: r.mention_count, pings: [] } : { counted: was?.counted ?? 0, pings: was?.pings ?? [] }),
      });
    }
    // After a switch core's stored states are the last account's: all of them go.
    this.onCounts(this.counts(), switched ? 'reset' : partial ? 'merge' : 'replace');
    this.diag('read-states-ready', {
      fields: Object.keys(d),
      readState: Array.isArray(d['read_state']) ? 'array' : typeof d['read_state'],
      entries: entries.length,
      entryFields: Object.keys(entries[0] ?? {}),
      partial,
      mentioned: [...this.states.values()].filter((s) => mentionsOf(s) > 0).length,
      serversWithRoles: this.roles.size,
      settings: this.settings.size,
    });
  }

  /** The owner's roles from `merged_members`: one list per server, in the order of the payload's `guilds`. */
  private ownRoles(d: Record<string, unknown>): void {
    const guilds = (d['guilds'] as { id: string }[] | undefined) ?? [];
    const members = (d['merged_members'] as { user_id: string; roles?: string[] }[][] | undefined) ?? [];
    guilds.forEach((g, i) => {
      const me = members[i]?.find((m) => m.user_id === this.self);
      if (me?.roles) this.roles.set(g.id, new Set(me.roles));
    });
    if (members.length) this.diag('read-states-roles', { servers: guilds.length, withRoles: this.roles.size });
  }

  private message(m: PingMessage): void {
    const state = this.states.get(m.channel_id) ?? UNREAD;
    if (this.self !== null && m.author?.id === this.self) {
      if (m.type !== POLL_RESULT_MESSAGE) this.confirm(m.channel_id, { ackId: m.id, counted: 0, pings: [] });
      return;
    }
    if (state.ackId && compareSnowflakes(m.id, state.ackId) <= 0) return;
    if (!this.pings(m)) return;
    // An ack sending may fail: the state it returns to counts this ping too.
    const back = this.rollbacks.get(m.channel_id);
    if (back && !(back.ackId && compareSnowflakes(m.id, back.ackId) <= 0)) this.rollbacks.set(m.channel_id, { ...back, pings: [...back.pings, m.id] });
    this.put(m.channel_id, { ...state, pings: [...state.pings, m.id] });
  }

  /** Discord's rule for a new message counting as a mention (docs.discord.food → Read State → Message Create). */
  private pings(m: PingMessage): boolean {
    const self = this.self;
    const named = self !== null && (m.mentions ?? []).some((u) => u.id === self);
    if (!m.guild_id) {
      const dmSettings = this.settings.get('')?.channel_overrides?.find((o) => o.channel_id === m.channel_id);
      return m.type !== RECIPIENT_REMOVE_MESSAGE && (named || !dmSettings || !mutedNow(dmSettings, this.now()));
    }
    const guild = this.settings.get(m.guild_id);
    const roles = this.roles.get(m.guild_id);
    const role = !guild?.suppress_roles && (m.mention_roles ?? []).some((r) => roles?.has(r) === true);
    const everyone = !guild?.suppress_everyone && m.mention_everyone === true;
    return named || role || everyone;
  }

  private put(channelId: string, state: ReadState): void {
    this.states.set(channelId, state);
    this.onCounts([this.count(channelId)], 'merge');
  }

  /** Discord's own word on a channel (its ack, or the owner's message): an ack of ours sending has nothing to return to. */
  private confirm(channelId: string, state: ReadState): void {
    this.rollbacks.delete(channelId);
    this.put(channelId, state);
  }

  /**
   * What core keeps for a channel: its mention count, and for a DM its last read message and mute end. A field this
   * session doesn't know is left out, so core keeps its stored value.
   */
  private count(channelId: string): ReadStateCount {
    const s = this.states.get(channelId);
    const count: ReadStateCount = { channelId, ...(s ? { mentionCount: mentionsOf(s) } : {}) };
    if (!this.dms.has(channelId)) return count;
    if (s?.ackId !== undefined) count.ackId = s.ackId;
    const dmSettings = this.settings.get('');
    if (dmSettings || this.settingsFull) count.muteEndsMs = muteEndsMs(dmSettings?.channel_overrides?.find((o) => o.channel_id === channelId));
    return count;
  }

  private counts(): ReadStateCount[] {
    return [...new Set([...this.states.keys(), ...this.dms])].map((id) => this.count(id));
  }
}
