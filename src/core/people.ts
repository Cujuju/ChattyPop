// Users and their server nicknames and roles (members), as message authors and member events report them.
import type { MemberPayloadMode, RawMemberPatch, RawUserPatch } from '@shared/discord';
import type { Db } from './db';

/** The server tag Discord draws beside the name: null when the user has none or turned it off. */
function serverTag(u: RawUserPatch): { guildId: string; tag: string; badge: string | null } | null {
  const g = u.primary_guild;
  return g?.identity_enabled !== false && g?.tag && g.identity_guild_id ? { guildId: g.identity_guild_id, tag: g.tag, badge: g.badge ?? null } : null;
}

/** Optional columns and the payload flags that say whether they are known. Shared by merging and change detection. */
const USER_PATCH_COLUMNS = {
  global_name: 'globalNameKnown', avatar: 'avatarKnown', tag_guild_id: 'tagKnown', tag: 'tagKnown',
  tag_badge: 'tagKnown', name_style: 'styleKnown', decoration: 'decorationKnown', bot: 'botKnown',
};
const userUpdates = Object.entries(USER_PATCH_COLUMNS)
  .map(([column, known]) => `${column} = CASE WHEN @${known} THEN excluded.${column} ELSE users.${column} END`).join(', ');
const userChanges = Object.entries(USER_PATCH_COLUMNS)
  .map(([column, known]) => `(@${known} AND users.${column} IS NOT excluded.${column})`).join(' OR ');

/** Historical mentions seed unknown identities; current observed facts may merge into existing users. */
export type UserMergeMode = 'merge' | 'keep';

export function upsertUser(db: Db, u: RawUserPatch, mode: UserMergeMode = 'merge'): void {
  if (!u.id || !Object.entries(u).some(([key, value]) => key !== 'id' && value !== undefined)) return;
  // Unknown id-only users stay unknown until Discord supplies a username. Existing users accept partial updates.
  const username = u.username ?? (db.prepare('SELECT username FROM users WHERE id = ?').pluck().get(u.id) as string | undefined);
  if (!username) return;
  const tag = serverTag(u);
  db.prepare(
    `INSERT INTO users (id, username, global_name, avatar, tag_guild_id, tag, tag_badge, name_style, decoration, bot)
     VALUES (@id, @username, @globalName, @avatar, @tagGuildId, @tag, @tagBadge, @nameStyle, @decoration, @bot)
     ON CONFLICT(id) DO UPDATE SET username = excluded.username, ${userUpdates}
     WHERE @mergeExisting AND (users.username IS NOT excluded.username OR ${userChanges})`,
  ).run({
    id: u.id,
    username,
    mergeExisting: mode === 'merge' ? 1 : 0,
    globalName: u.global_name ?? null,
    avatar: u.avatar ?? null,
    globalNameKnown: u.global_name !== undefined ? 1 : 0,
    avatarKnown: u.avatar !== undefined ? 1 : 0,
    tagGuildId: tag?.guildId ?? null,
    tag: tag?.tag ?? null,
    tagBadge: tag?.badge ?? null,
    nameStyle: u.display_name_styles ? JSON.stringify(u.display_name_styles) : null,
    decoration: u.avatar_decoration_data?.asset ?? null,
    tagKnown: u.primary_guild !== undefined ? 1 : 0,
    styleKnown: u.display_name_styles !== undefined ? 1 : 0,
    decorationKnown: u.avatar_decoration_data !== undefined ? 1 : 0,
    bot: u.bot === true ? 1 : 0,
    botKnown: typeof u.bot === 'boolean' ? 1 : 0,
  });
}

/** A timeout's end as epoch ms; null for none or an unreadable time. */
function timeoutEnd(iso: string | null | undefined): number | null {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? at : null;
}

/** `seenAt`: when the payload was true; an older payload (a message ingested late) never overwrites a newer one. */
export function putMember(db: Db, guildId: string | null, userId: string, mem: RawMemberPatch, seenAt: number, mode: MemberPayloadMode = 'snapshot'): void {
  if (!guildId) return;
  // A payload without roles or a timeout (some member-list items) keeps the stored ones. A newer one than their leaving
  // means they rejoined.
  db.prepare(
    `INSERT INTO members (guild_id, user_id, nick, roles, timed_out_until, updated_at) VALUES (@guildId, @userId, @nick, @roles, @timedOutUntil, @seenAt)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET nick = CASE WHEN @nickKnown THEN excluded.nick ELSE members.nick END,
       roles = COALESCE(excluded.roles, members.roles),
       timed_out_until = CASE WHEN @timeoutKnown THEN excluded.timed_out_until ELSE members.timed_out_until END,
       updated_at = excluded.updated_at, left_at = NULL
     WHERE excluded.updated_at >= members.updated_at`,
  ).run({
    guildId,
    userId,
    nick: mem.nick ?? null,
    nickKnown: mode === 'snapshot' || mem.nick !== undefined ? 1 : 0,
    roles: mem.roles ? JSON.stringify(mem.roles) : null,
    timedOutUntil: timeoutEnd(mem.communication_disabled_until),
    timeoutKnown: mem.communication_disabled_until !== undefined ? 1 : 0,
    seenAt,
  });
}

/** They left the server (GUILD_MEMBER_REMOVE) at `seenAt`: kept for their old messages, no longer a member. */
export function markMemberLeft(db: Db, guildId: string, userId: string, seenAt: number): void {
  db.prepare(
    `INSERT INTO members (guild_id, user_id, updated_at, left_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET updated_at = excluded.updated_at, left_at = excluded.left_at
     WHERE excluded.updated_at >= members.updated_at`,
  ).run(guildId, userId, seenAt, seenAt);
}

/** Server nicknames and roles from member events (GUILD_MEMBERS_CHUNK, GUILD_MEMBER_UPDATE, the member list). */
export function upsertMembers(db: Db, guildId: string, members: RawMemberPatch[], mode: MemberPayloadMode = 'snapshot'): void {
  const now = Date.now();
  db.transaction(() => {
    for (const mem of members) {
      const userId = mem.user?.id ?? mem.user_id;
      if (!userId) continue;
      if (mem.user) upsertUser(db, mem.user);
      // Membership is an observed fact even when its user's name has not arrived yet.
      putMember(db, guildId, userId, mem, now, mode);
    }
  })();
}

/** The server a channel belongs to; null when the channel is unknown or has none. */
export function guildOf(db: Db, channelId: string): string | null {
  return (db.prepare('SELECT guild_id AS guildId FROM channels WHERE id = ?').get(channelId) as { guildId: string | null } | undefined)?.guildId ?? null;
}
