// Computes Discord channel permissions from ownership, everyone/member roles, Administrator, overwrites, implicit restrictions and timeouts.

/** Discord permission bits (docs: Permissions → Bitwise Permission Flags). */
export const PERMISSIONS = {
  ADMINISTRATOR: 1n << 3n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  SEND_TTS_MESSAGES: 1n << 12n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MENTION_EVERYONE: 1n << 17n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
} as const;

/** What a member can't do without the right to send in the channel (docs: Implicit Permissions). */
const SEND_DEPENDENT = PERMISSIONS.MENTION_EVERYONE | PERMISSIONS.SEND_TTS_MESSAGES | PERMISSIONS.EMBED_LINKS | PERMISSIONS.ATTACH_FILES;
/** All a timed-out member keeps (docs: Guild → Modify Guild Member, communication_disabled_until). */
const TIMED_OUT_KEEPS = PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.READ_MESSAGE_HISTORY;

/** A private thread's channel type: seen only by those added to it and moderators (Manage Threads). */
export const PRIVATE_THREAD_TYPE = 12;

/** Every bit set: what the owner and an administrator get. */
const ALL = ~0n;

/** A channel's permission overwrite as Discord sends it; `type` 0 = role, 1 = member. */
export interface RawOverwrite {
  id: string;
  type: number;
  allow: string;
  deny: string;
}

const ROLE_OVERWRITE = 0;
const MEMBER_OVERWRITE = 1;

/** What a server's permissions depend on; @everyone is the role whose id is the server's. */
export interface PermissionContext {
  guildId: string;
  /** Null when not yet known: no one is treated as owner. */
  ownerId: string | null;
  /** Each role's permission bits by role id. */
  rolePermissions: ReadonlyMap<string, bigint>;
  overwrites: readonly RawOverwrite[];
  /** The channel asked about is a thread: `overwrites` are its parent's, and sending there takes SEND_MESSAGES_IN_THREADS. */
  thread?: boolean;
}

/** A member as permissions read them. */
export interface MemberFacts {
  /** Role ids, never @everyone. */
  roles: readonly string[];
  /** When their timeout ends (epoch ms); null or past when they aren't timed out. */
  timedOutUntil?: number | null;
}

/** Permission bits from Discord's decimal string; unreadable = none. */
export function permissionBits(v: unknown): bigint {
  try {
    return typeof v === 'string' || typeof v === 'number' ? BigInt(v) : 0n;
  } catch {
    return 0n;
  }
}

/** An overwrite's bits; none when it is absent. */
const layerOf = (o: RawOverwrite | undefined): { allow: bigint; deny: bigint } => ({ allow: permissionBits(o?.allow), deny: permissionBits(o?.deny) });

/** The member's effective permissions in the channel at `now`. */
export function channelPermissions(ctx: PermissionContext, userId: string, member: MemberFacts, now: number = Date.now()): bigint {
  if (ctx.ownerId === userId) return ALL;
  const { roles } = member;
  let p = ctx.rolePermissions.get(ctx.guildId) ?? 0n;
  for (const r of roles) p |= ctx.rolePermissions.get(r) ?? 0n;
  if (p & PERMISSIONS.ADMINISTRATOR) return ALL;
  // Three layers, each clearing its denied bits before setting its allowed ones: @everyone's overwrite, then the
  // member's roles' overwrites merged into one, then the member's own.
  const roleLayer = ctx.overwrites
    .filter((o) => o.type === ROLE_OVERWRITE && o.id !== ctx.guildId && roles.includes(o.id))
    .reduce((acc, o) => ({ allow: acc.allow | permissionBits(o.allow), deny: acc.deny | permissionBits(o.deny) }), { allow: 0n, deny: 0n });
  const layers = [layerOf(ctx.overwrites.find((o) => o.id === ctx.guildId)), roleLayer, layerOf(ctx.overwrites.find((o) => o.type === MEMBER_OVERWRITE && o.id === userId))];
  let effective = layers.reduce((acc, l) => (acc & ~l.deny) | l.allow, p);
  // Unable to see the channel, a member can do nothing in it; unable to send, nothing that rides on a message.
  if (!(effective & PERMISSIONS.VIEW_CHANNEL)) return 0n;
  if (!(effective & (ctx.thread ? PERMISSIONS.SEND_MESSAGES_IN_THREADS : PERMISSIONS.SEND_MESSAGES))) effective &= ~SEND_DEPENDENT;
  if (member.timedOutUntil != null && member.timedOutUntil > now) effective &= TIMED_OUT_KEEPS;
  return effective;
}

export const can = (ctx: PermissionContext, userId: string, member: MemberFacts, permission: bigint, now?: number): boolean =>
  (channelPermissions(ctx, userId, member, now) & permission) === permission;

/** What main reads from the gateway that decides who can see a channel. */
export interface AccessFacts {
  /** `name` lets a server not yet archived be stored; null when the payload had none. */
  owners: { guildId: string; name: string | null; ownerId: string }[];
  overwrites: { channelId: string; overwrites: RawOverwrite[] }[];
  /** Members' roles (the owner's own, from READY's merged_members). */
  members: { guildId: string; userId: string; nick: string | null; roles: string[]; /** Discord's ISO time; absent when the payload had none. */ communicationDisabledUntil?: string | null }[];
}
