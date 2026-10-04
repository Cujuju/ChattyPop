// A member's permissions in a channel, by Discord's published rules (docs: Permissions → Permission Overwrites): the
// server's owner has all; else @everyone and the member's roles, Administrator granting all, then the channel's overwrites.

/** Discord permission bits (docs: Permissions → Bitwise Permission Flags). */
export const PERMISSIONS = {
  ADMINISTRATOR: 1n << 3n,
  VIEW_CHANNEL: 1n << 10n,
  MENTION_EVERYONE: 1n << 17n,
} as const;

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

/** The member's permissions in the channel; `roles` are their role ids (never @everyone). */
export function channelPermissions(ctx: PermissionContext, userId: string, roles: readonly string[]): bigint {
  if (ctx.ownerId === userId) return ALL;
  let p = ctx.rolePermissions.get(ctx.guildId) ?? 0n;
  for (const r of roles) p |= ctx.rolePermissions.get(r) ?? 0n;
  if (p & PERMISSIONS.ADMINISTRATOR) return ALL;
  // Three layers, each clearing its denied bits before setting its allowed ones: @everyone's overwrite, then the
  // member's roles' overwrites merged into one, then the member's own.
  const roleLayer = ctx.overwrites
    .filter((o) => o.type === ROLE_OVERWRITE && o.id !== ctx.guildId && roles.includes(o.id))
    .reduce((acc, o) => ({ allow: acc.allow | permissionBits(o.allow), deny: acc.deny | permissionBits(o.deny) }), { allow: 0n, deny: 0n });
  const layers = [layerOf(ctx.overwrites.find((o) => o.id === ctx.guildId)), roleLayer, layerOf(ctx.overwrites.find((o) => o.type === MEMBER_OVERWRITE && o.id === userId))];
  return layers.reduce((acc, l) => (acc & ~l.deny) | l.allow, p);
}

export const can = (ctx: PermissionContext, userId: string, roles: readonly string[], permission: bigint): boolean =>
  (channelPermissions(ctx, userId, roles) & permission) === permission;

/** What main reads from the gateway that decides who can see a channel. */
export interface AccessFacts {
  /** `name` lets a server not yet archived be stored; null when the payload had none. */
  owners: { guildId: string; name: string | null; ownerId: string }[];
  overwrites: { channelId: string; overwrites: RawOverwrite[] }[];
  /** Members' roles (the owner's own, from READY's merged_members). */
  members: { guildId: string; userId: string; nick: string | null; roles: string[] }[];
}
