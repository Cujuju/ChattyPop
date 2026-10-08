// Minimal Discord payload shapes ChattyPop reads. Everything else is kept verbatim in raw_json.
import type { ArchiveEmoji } from './types/archive';
import type { RawOverwrite } from './permissions';
import { BYTES_PER_MB } from './units';

/** Discord's answer for a message, channel or other resource that no longer exists. */
export const HTTP_NOT_FOUND = 404;

/** A Discord API request Discord answered with an error status (after any retries). */
export class DiscordHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
  }
}

export interface RawUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
  /** Bots and webhooks. */
  bot?: boolean;
  /** Discord's badge flags (VERIFIED_BOT_FLAG…). */
  public_flags?: number;
  /** The server tag the user shows beside their name; absent when the payload doesn't say, null for none. */
  primary_guild?: RawPrimaryGuild | null;
  /** Nitro display-name style; absent when the payload doesn't say, null for none. */
  display_name_styles?: RawDisplayNameStyles | null;
  /** The frame drawn around the avatar; absent when the payload doesn't say, null for none. */
  avatar_decoration_data?: { asset: string; sku_id?: string } | null;
}

/** `font_id`: Discord's font enum (shared/nameFonts.ts); `effect_id`: its effect enum; `colors`: 0xRRGGBB. */
export interface RawDisplayNameStyles {
  font_id?: number;
  effect_id?: number;
  colors?: number[];
}

export interface RawPrimaryGuild {
  identity_guild_id?: string | null;
  /** False: the user turned the tag off. */
  identity_enabled?: boolean | null;
  tag?: string | null;
  /** Badge image hash (cdn clan-badges/<guild>/<hash>). */
  badge?: string | null;
}

/** A server member as live messages and member events carry it. `nick`: server nickname; absent or null = none. */
export interface RawMember {
  user?: RawUser;
  nick?: string | null;
  /** The member's role ids (never @everyone); absent when the payload doesn't carry them. */
  roles?: string[];
  /** When their timeout ends (ISO time); null when not timed out, absent when the payload doesn't say. */
  communication_disabled_until?: string | null;
}

/** A gateway user update may carry only its id and the fields that changed. */
export type RawUserPatch = Pick<RawUser, 'id'> & Partial<Omit<RawUser, 'id'>>;

/** Partial member updates preserve omitted fields. READY's merged members refer to its user table by user_id. */
export type RawMemberPatch = Omit<RawMember, 'user'> & { user?: RawUserPatch; user_id?: string };

/** Full snapshots clear an omitted nickname; partial updates preserve it. */
export type MemberPayloadMode = 'snapshot' | 'patch';

/** Only identity facts cross to core from large guild and startup dispatches. */
export interface GatewayGuildPeople {
  id: string;
  members?: RawMemberPatch[];
  presences?: { user?: RawUserPatch }[];
}

export interface GatewayReadyPeople {
  user?: RawUserPatch;
  users?: RawUserPatch[];
  guilds?: GatewayGuildPeople[];
  merged_members?: RawMemberPatch[][];
}

/** A server role. `color`: 0xRRGGBB, 0 for none; `icon`: image hash (cdn role-icons/<id>/<hash>). */
export interface RawRole {
  id: string;
  name: string;
  color?: number;
  position?: number;
  icon?: string | null;
  unicode_emoji?: string | null;
  [key: string]: unknown;
}

export interface RawMessage {
  id: string;
  channel_id: string;
  author: RawUser;
  content: string;
  timestamp: string;
  edited_timestamp: string | null;
  mentions?: (RawUserPatch & { member?: RawMember })[];
  [key: string]: unknown;
}

/** MESSAGE_UPDATE may carry only changed fields (e.g. embeds unfurled later, no content). */
export type RawMessageUpdate = Partial<RawMessage> & { id: string; channel_id: string };

export interface RawGuild {
  id: string;
  name: string;
  icon?: string | null;
  /** Server features (ENHANCED_ROLE_COLORS…); absent when the payload doesn't carry them. */
  features?: string[];
}

export interface RawChannel {
  id: string;
  name: string;
  type: number;
  parent_id?: string | null;
  position?: number;
  /** Who may see and use it beyond the server's roles; absent when the payload doesn't carry them. */
  permission_overwrites?: RawOverwrite[];
}

/** DM payloads use recipients unless groups have explicit names. Missing fields preserve stored values; null clears them. */
export interface RawPrivateChannel {
  id: string;
  type: number;
  name?: string | null;
  /** A group DM's own icon hash; null for the default. */
  icon?: string | null;
  /** Every member but the signed-in user; absent when the payload doesn't carry the roster. */
  recipients?: RawUser[];
  last_message_id?: string | null;
  /** A group DM's owner. */
  owner_id?: string | null;
  /** Discord's message-request and spam flags (assumed present on user accounts: docs/dms.md §3.2). */
  is_message_request?: boolean;
  is_spam?: boolean;
}

/** Sentinel DM mute end representing indefinite mute. */
export const MUTED_FOREVER = Number.MAX_SAFE_INTEGER;

/** A snowflake's digits, for building path patterns; SNOWFLAKE_ID matches one whole string. */
export const SNOWFLAKE_DIGITS = String.raw`\d{15,21}`;
/** Discord user flag VERIFIED_BOT (1 << 16): its APP tag carries a check. */
export const VERIFIED_BOT_FLAG = 1 << 16;
/** Discord message flag IS_VOICE_MESSAGE (1 << 13). */
export const VOICE_MESSAGE_FLAG = 1 << 13;

/** A Discord id (snowflake) as it appears in paths. */
export const SNOWFLAKE_ID = new RegExp(`^${SNOWFLAKE_DIGITS}$`);

/** `v` as a snowflake id, for an id from the renderer that goes into a Discord path; throws `Not a <what> id.` otherwise. */
export function snowflakeArg(v: unknown, what: string): string {
  if (typeof v !== 'string' || !SNOWFLAKE_ID.test(v)) throw new Error(`Not a ${what} id.`);
  return v;
}

/** Directory group holding DMs; also Discord's route segment for them (/channels/@me/<id>). */
export const DM_GUILD_ID = '@me';

/** Characters in one message for an account without Nitro. */
export const DISCORD_TEXT_MAX = 2000;
/** Attachments one message can carry. */
export const DISCORD_FILES_PER_MESSAGE_MAX = 10;
/** Bytes per uploaded file for an account without Nitro. */
export const DISCORD_UPLOAD_BYTES_MAX = 10 * BYTES_PER_MB;

/** Discord's allowed_mentions: who a sent message may ping. A kind listed by id can't also be in `parse`. */
export interface AllowedMentions {
  parse: ('users' | 'roles' | 'everyone')[];
  users?: string[];
  roles?: string[];
  replied_user: boolean;
}

/** What Discord's client sends with a typed message: every mention in it pings; a reply pings its author when `ping` (@ON). */
export const typedMentions = (ping: boolean): AllowedMentions => ({ parse: ['users', 'roles', 'everyone'], replied_user: ping });
export const DM_GROUP_NAME = 'Direct messages';
/** DM and group DM. */
/** A one-to-one DM (3 is a group DM). */
export const DM_CHANNEL_TYPE = 1;
export const GROUP_DM_CHANNEL_TYPE = 3;
export const DM_CHANNEL_TYPES = new Set([DM_CHANNEL_TYPE, GROUP_DM_CHANNEL_TYPE]);
/** Guild channels whose threads (or forum posts) sync looks for. */
export const THREAD_PARENT_TYPES = new Set([0, 5, 15]);

/** A DM's display name: the group's name, else its recipients. */
export const privateChannelName = (c: RawPrivateChannel): string =>
  c.name || (c.recipients ?? []).map((u) => u.global_name || u.username).join(', ') || 'Direct message';

/** A thread (or forum post) as channel lists, thread search and THREAD_* gateway events return it. */
export interface RawThread extends RawChannel {
  guild_id?: string;
  parent_id: string;
  last_message_id?: string | null;
}

/** Discord channel types ChattyPop can archive (text-bearing). */
export const TEXT_CHANNEL_TYPES = new Set([0, 1, 3, 5, 10, 11, 12, 15]); // text, DM, group DM, announcement, threads, forum
/** Announcement, public and private threads. Forum posts are public threads. */
export const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);
/** Forum channels hold only threads (posts); they have no messages of their own. */
export const FORUM_CHANNEL_TYPE = 15;
/** A plain server text channel: the only kind /thread starts threads in. */
export const GUILD_TEXT_CHANNEL_TYPE = 0;
/** Discord's type for a public thread. */
export const PUBLIC_THREAD_TYPE = 11;
/** Longest thread name Discord accepts. */
export const THREAD_NAME_MAX = 100;
export const CATEGORY_CHANNEL_TYPE = 4;

/** Discord epoch (2015-01-01T00:00:00Z) in ms; snowflake ids encode ms since it in bits 22+. */
const DISCORD_EPOCH_MS = 1420070400000n;
export const SNOWFLAKE_TIMESTAMP_SHIFT = 22n;

export const snowflakeToMs = (id: string): number => Number((BigInt(id) >> SNOWFLAKE_TIMESTAMP_SHIFT) + DISCORD_EPOCH_MS);
/** Values the low (non-time) bits of a snowflake can hold. */
export const SNOWFLAKE_LOW_BITS_RANGE = 2 ** Number(SNOWFLAKE_TIMESTAMP_SHIFT);
/** A snowflake for a time; `low` (below SNOWFLAKE_LOW_BITS_RANGE) separates ids of the same millisecond. */
export const snowflakeFromMs = (ms: number, low = 0): string => (((BigInt(ms) - DISCORD_EPOCH_MS) << SNOWFLAKE_TIMESTAMP_SHIFT) + BigInt(low)).toString();

/** Generates client-style snowflake nonces from current time and random low bits. */
export const newNonce = (): string => snowflakeFromMs(Date.now(), Math.floor(Math.random() * SNOWFLAKE_LOW_BITS_RANGE));
/** Distinct display names/usernames usable as addressing terms. */
export const userNames = (u: Pick<RawUser, 'global_name' | 'username'>): string[] => [...new Set([u.global_name, u.username].filter((n): n is string => !!n))];

export const compareSnowflakes = (a: string, b: string): number => {
  const d = BigInt(a) - BigInt(b);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
};

/** A directory row as DM order reads it. */
type DmRanked = { id: string; dm?: { lastMessageId: string | null } };
/** Discord's DM order: newest message first; a DM without one ranks by its own id (when it was made). */
export const byDmActivity = (a: DmRanked, b: DmRanked): number => compareSnowflakes(b.dm?.lastMessageId ?? b.id, a.dm?.lastMessageId ?? a.id);

/** The emoji as Discord's reaction URL takes it: the unicode emoji, or name:id for a custom one, URL-encoded. */
export const reactionPathPart = (e: ArchiveEmoji): string => encodeURIComponent(e.id ? `${e.name}:${e.id}` : e.name);

/** `v` is an emoji a reaction can use (it comes from a renderer or a stored rule). */
export const isReactionEmoji = (v: unknown): v is ArchiveEmoji => {
  const e = v as Partial<ArchiveEmoji> | null;
  return !!e && typeof e.name === 'string' && e.name !== '' && (e.id === null || (typeof e.id === 'string' && SNOWFLAKE_ID.test(e.id))) && typeof e.animated === 'boolean';
};
