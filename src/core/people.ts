// Users and their server nicknames and roles (members), as message authors and member events report them.
import type { RawMember, RawUser } from '@shared/discord';
import type { Db } from './db';

/** The server tag Discord draws beside the name: null when the user has none or turned it off. */
function serverTag(u: RawUser): { guildId: string; tag: string; badge: string | null } | null {
  const g = u.primary_guild;
  return g?.identity_enabled !== false && g?.tag && g.identity_guild_id ? { guildId: g.identity_guild_id, tag: g.tag, badge: g.badge ?? null } : null;
}

/** Kept unless the payload says: a field absent from it (a partial user) leaves the stored value. */
const kept = (column: string, known: string): string => `${column} = CASE WHEN @${known} THEN excluded.${column} ELSE users.${column} END`;

export function upsertUser(db: Db, u: RawUser): void {
  const tag = serverTag(u);
  db.prepare(
    `INSERT INTO users (id, username, global_name, avatar, tag_guild_id, tag, tag_badge, name_style, decoration)
     VALUES (@id, @username, @globalName, @avatar, @tagGuildId, @tag, @tagBadge, @nameStyle, @decoration)
     ON CONFLICT(id) DO UPDATE SET username = excluded.username, global_name = excluded.global_name, avatar = excluded.avatar,
       ${kept('tag_guild_id', 'tagKnown')}, ${kept('tag', 'tagKnown')}, ${kept('tag_badge', 'tagKnown')},
       ${kept('name_style', 'styleKnown')}, ${kept('decoration', 'decorationKnown')}`,
  ).run({
    id: u.id,
    username: u.username,
    globalName: u.global_name ?? null,
    avatar: u.avatar ?? null,
    tagGuildId: tag?.guildId ?? null,
    tag: tag?.tag ?? null,
    tagBadge: tag?.badge ?? null,
    nameStyle: u.display_name_styles ? JSON.stringify(u.display_name_styles) : null,
    decoration: u.avatar_decoration_data?.asset ?? null,
    tagKnown: u.primary_guild !== undefined ? 1 : 0,
    styleKnown: u.display_name_styles !== undefined ? 1 : 0,
    decorationKnown: u.avatar_decoration_data !== undefined ? 1 : 0,
  });
}

/** A timeout's end as epoch ms; null for none or an unreadable time. */
function timeoutEnd(iso: string | null | undefined): number | null {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? at : null;
}

/** `seenAt`: when the payload was true; an older payload (a message ingested late) never overwrites a newer one. */
export function putMember(db: Db, guildId: string | null, userId: string, mem: RawMember, seenAt: number): void {
  if (!guildId) return;
  // A payload without roles or a timeout (some member-list items) keeps the stored ones. A newer one than their leaving
  // means they rejoined.
  db.prepare(
    `INSERT INTO members (guild_id, user_id, nick, roles, timed_out_until, updated_at) VALUES (@guildId, @userId, @nick, @roles, @timedOutUntil, @seenAt)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET nick = excluded.nick, roles = COALESCE(excluded.roles, members.roles),
       timed_out_until = CASE WHEN @timeoutKnown THEN excluded.timed_out_until ELSE members.timed_out_until END,
       updated_at = excluded.updated_at, left_at = NULL
     WHERE excluded.updated_at >= members.updated_at`,
  ).run({
    guildId,
    userId,
    nick: mem.nick ?? null,
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
export function upsertMembers(db: Db, guildId: string, members: RawMember[]): void {
  const now = Date.now();
  db.transaction(() => {
    for (const mem of members) {
      if (!mem.user?.id || !mem.user.username) continue;
      upsertUser(db, mem.user);
      putMember(db, guildId, mem.user.id, mem, now);
    }
  })();
}

/** The server a channel belongs to; null when the channel is unknown or has none. */
export function guildOf(db: Db, channelId: string): string | null {
  return (db.prepare('SELECT guild_id AS guildId FROM channels WHERE id = ?').get(channelId) as { guildId: string | null } | undefined)?.guildId ?? null;
}
