// Discord's profile, mutual-friend and reactor answers, cached whole and read back as the Person window and
// the reaction tooltip show them. Storing one also refreshes the people it names (users, server nickname and roles).
import type { RawUser } from '@shared/discord';
import type { PersonMatch } from '@shared/types/people';
import type { DiscordProfile, FetchedProfile, MutualFriends, RawProfile, ReactionUsers } from '@shared/types/discordProfile';
import type { Db } from './db';
import { putMember, upsertUser } from './people';
import { peopleByIds } from './queries/people';

/** The cache's key for a profile seen outside any server (a key column can't hold NULL as one value). */
const NO_GUILD = '';

/** People in the order Discord listed them; ids the archive doesn't know are left out. */
function peopleInOrder(db: Db, ids: string[]): PersonMatch[] {
  const byId = new Map(peopleByIds(db, ids).map((p) => [p.id, p]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

function upsertUsers(db: Db, users: RawUser[]): void {
  for (const u of users) upsertUser(db, u);
}

export function storeProfile(db: Db, f: FetchedProfile): DiscordProfile {
  db.transaction(() => {
    upsertUser(db, f.raw.user);
    const mem = f.raw.guild_member;
    if (mem) putMember(db, f.guildId, f.userId, { nick: mem.nick ?? null, roles: mem.roles }, f.fetchedAt);
    db.prepare(
      `INSERT INTO discord_profiles (user_id, guild_id, profile_json, note, friends_since, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, guild_id) DO UPDATE SET profile_json = excluded.profile_json, note = excluded.note,
         friends_since = excluded.friends_since, fetched_at = excluded.fetched_at`,
    ).run(f.userId, f.guildId ?? NO_GUILD, JSON.stringify(f.raw), f.note, f.friendsSince, f.fetchedAt);
  })();
  return cachedProfile(db, f.userId, f.guildId)!;
}

/** The last profile Discord sent for this person in this server; null before the first. */
export function cachedProfile(db: Db, userId: string, guildId: string | null): DiscordProfile | null {
  const row = db
    .prepare('SELECT profile_json AS json, note, friends_since AS friendsSince, fetched_at AS fetchedAt FROM discord_profiles WHERE user_id = ? AND guild_id = ?')
    .get(userId, guildId ?? NO_GUILD) as { json: string; note: string | null; friendsSince: number | null; fetchedAt: number } | undefined;
  if (!row) return null;
  const raw = JSON.parse(row.json) as RawProfile;
  const mem = raw.guild_member;
  const roleIds = JSON.stringify(mem?.roles ?? []);
  const roles = db
    .prepare(
      `SELECT id, name, NULLIF(color, 0) AS color FROM roles WHERE guild_id = ? AND id IN (SELECT value FROM json_each(?))
       ORDER BY position DESC, id`,
    )
    .all(guildId ?? NO_GUILD, roleIds) as DiscordProfile['roles'];
  const guilds = db
    .prepare(`SELECT id, name, icon FROM guilds WHERE id IN (SELECT value FROM json_each(?)) AND id NOT IN (SELECT id FROM hidden_ids)`)
    .all(JSON.stringify((raw.mutual_guilds ?? []).map((g) => g.id))) as { id: string; name: string | null; icon: string | null }[];
  const shown = new Map(guilds.map((g) => [g.id, g]));
  return {
    userId,
    guildId,
    banner: raw.user_profile?.banner ?? raw.user.banner ?? null,
    accentColor: raw.user_profile?.accent_color ?? raw.user.accent_color ?? null,
    bio: mem?.bio || raw.guild_member_profile?.bio || raw.user_profile?.bio || raw.user.bio || '',
    pronouns: raw.guild_member_profile?.pronouns || raw.user_profile?.pronouns || '',
    badges: (raw.badges ?? []).map((b) => ({ id: b.id, description: b.description, icon: b.icon, link: b.link ?? null })),
    joinedAt: mem?.joined_at ? Date.parse(mem.joined_at) : null,
    roles,
    note: row.note,
    friendsSince: row.friendsSince,
    mutualGuilds: (raw.mutual_guilds ?? []).flatMap((g) => {
      const known = shown.get(g.id);
      return known ? [{ ...known, nick: g.nick }] : [];
    }),
    mutualFriendsCount: raw.mutual_friends_count ?? 0,
    connections: (raw.connected_accounts ?? []).map((c) => ({ type: c.type, name: c.name, verified: c.verified === true })),
    fetchedAt: row.fetchedAt,
  };
}

export function storeMutualFriends(db: Db, userId: string, friends: RawUser[], fetchedAt: number): MutualFriends {
  db.transaction(() => {
    upsertUsers(db, friends);
    db.prepare(
      `INSERT INTO discord_mutual_friends (user_id, user_ids, fetched_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET user_ids = excluded.user_ids, fetched_at = excluded.fetched_at`,
    ).run(userId, JSON.stringify(friends.map((u) => u.id)), fetchedAt);
  })();
  return cachedMutualFriends(db, userId)!;
}

export function cachedMutualFriends(db: Db, userId: string): MutualFriends | null {
  const row = db.prepare('SELECT user_ids AS ids, fetched_at AS fetchedAt FROM discord_mutual_friends WHERE user_id = ?').get(userId) as
    | { ids: string; fetchedAt: number }
    | undefined;
  return row ? { people: peopleInOrder(db, JSON.parse(row.ids) as string[]), fetchedAt: row.fetchedAt } : null;
}

/** `emojiKey`: a custom emoji's id, else the unicode emoji. `count`: the reaction's count Discord's answer belongs to. */
export function storeReactors(db: Db, messageId: string, emojiKey: string, users: RawUser[], count: number, fetchedAt: number): ReactionUsers {
  db.transaction(() => {
    upsertUsers(db, users);
    db.prepare(
      `INSERT INTO reactors (message_id, emoji_key, user_ids, count, fetched_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(message_id, emoji_key) DO UPDATE SET user_ids = excluded.user_ids, count = excluded.count, fetched_at = excluded.fetched_at`,
    ).run(messageId, emojiKey, JSON.stringify(users.map((u) => u.id)), count, fetchedAt);
  })();
  return cachedReactors(db, messageId, emojiKey)!;
}

export function cachedReactors(db: Db, messageId: string, emojiKey: string): ReactionUsers | null {
  const row = db
    .prepare('SELECT user_ids AS ids, count, fetched_at AS fetchedAt FROM reactors WHERE message_id = ? AND emoji_key = ?')
    .get(messageId, emojiKey) as { ids: string; count: number; fetchedAt: number } | undefined;
  return row ? { people: peopleInOrder(db, JSON.parse(row.ids) as string[]), count: row.count, fetchedAt: row.fetchedAt } : null;
}
