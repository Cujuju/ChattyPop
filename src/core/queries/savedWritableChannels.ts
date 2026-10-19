import type { SavedChannelAccess } from '@shared/savedMessages';
import { DM_CHANNEL_TYPES, THREAD_CHANNEL_TYPES } from '@shared/discord';
import { PRIVATE_THREAD_TYPE, PERMISSIONS, can, permissionBits, type PermissionContext, type MemberFacts, type RawOverwrite } from '@shared/permissions';
import type { Db } from '../db';
import { visibleChannelSql } from './privacy';

interface Channel {
  id: string; guildId: string; parentId: string | null; kind: number;
  accountId: string | null; closedAt: number | null; overwrites: string | null; parentOverwrites: string | null;
}

/** Native new saves require read-history access; hydrate each guild's permissions once per snapshot. */
export function savedWritableChannels(db: Db, accountId: string): SavedChannelAccess[] {
  const channels = db.prepare(`SELECT c.id, c.guild_id AS guildId, c.parent_id AS parentId, c.kind,
    c.account_id AS accountId, c.closed_at AS closedAt, c.overwrites, p.overwrites AS parentOverwrites
    FROM channels c LEFT JOIN channels p ON p.id = c.parent_id WHERE ${visibleChannelSql('c.id')}`).all() as Channel[];
  const guildIds = JSON.stringify([...new Set(channels.filter((c) => !DM_CHANNEL_TYPES.has(c.kind)).map((c) => c.guildId))]);
  const owners = new Map((db.prepare('SELECT id, owner_id AS ownerId FROM guilds WHERE id IN (SELECT value FROM json_each(?))')
    .all(guildIds) as { id: string; ownerId: string | null }[]).map((g) => [g.id, g.ownerId]));
  const roles = new Map<string, Map<string, bigint>>();
  for (const r of db.prepare(`SELECT id, guild_id AS guildId, json_extract(raw_json, '$.permissions') AS permissions
    FROM roles WHERE guild_id IN (SELECT value FROM json_each(?))`).all(guildIds) as { id: string; guildId: string; permissions: unknown }[]) {
    let guild = roles.get(r.guildId);
    if (!guild) roles.set(r.guildId, guild = new Map());
    guild.set(r.id, permissionBits(r.permissions));
  }
  const members = new Map((db.prepare(`SELECT guild_id AS guildId, roles, timed_out_until AS timedOutUntil FROM members
    WHERE user_id = ? AND guild_id IN (SELECT value FROM json_each(?))`).all(accountId, guildIds) as
    { guildId: string; roles: string | null; timedOutUntil: number | null }[])
    .map((m): [string, MemberFacts] => [m.guildId, { roles: m.roles ? JSON.parse(m.roles) as string[] : [], timedOutUntil: m.timedOutUntil }]));
  return channels.flatMap<SavedChannelAccess>((c) => {
    if (DM_CHANNEL_TYPES.has(c.kind)) return c.accountId === accountId && c.closedAt === null
      ? [{ channelId: c.id, guildId: null, parentId: null, privateThread: false }] : [];
    const thread = THREAD_CHANNEL_TYPES.has(c.kind);
    const raw = thread && c.parentId ? c.parentOverwrites : c.overwrites;
    const access: PermissionContext = { guildId: c.guildId, ownerId: owners.get(c.guildId) ?? null,
      rolePermissions: roles.get(c.guildId) ?? new Map(), overwrites: raw ? JSON.parse(raw) as RawOverwrite[] : [], thread };
    return can(access, accountId, members.get(c.guildId) ?? { roles: [], timedOutUntil: null }, PERMISSIONS.READ_MESSAGE_HISTORY)
      ? [{ channelId: c.id, guildId: c.guildId, parentId: thread ? c.parentId : null, privateThread: c.kind === PRIVATE_THREAD_TYPE }] : [];
  });
}
