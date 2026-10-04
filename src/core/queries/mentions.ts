// What the composer's `@` offers in a channel, in the order Discord's own list uses: the people who can see the
// channel, then @everyone and @here, then roles; `limit` in all, people first.
import type { MentionCandidate } from '@shared/contract';
import { DM_GUILD_ID, THREAD_CHANNEL_TYPES } from '@shared/discord';
import { foldName as fold, subsequence } from '@shared/nameMatch';
import { can, permissionBits, PERMISSIONS, type PermissionContext, type RawOverwrite } from '@shared/permissions';
import type { Db } from '../db';
import { rawJsonSql } from './messageContent';

interface Person {
  id: string;
  /** The name Discord shows here: server nickname, else display name, else username. */
  name: string;
  username: string;
  globalName: string | null;
  nick: string | null;
  avatar: string | null;
  /** Null when the server's member list hasn't named their roles. */
  roles: string[] | null;
  /** When they last posted in the channel; null if never. */
  lastTs: number | null;
}

/** How a person's names match `query`, best first: one starts with it as typed (0), once folded (1), loosely (2). */
const STARTS = 0;
const STARTS_FOLDED = 1;
const LOOSE = 2;
function personTier(p: Person, query: string): number | null {
  const typed = query.toLocaleLowerCase();
  const folded = fold(query);
  let best: number | null = null;
  for (const n of names(p)) {
    const tier = n.toLocaleLowerCase().startsWith(typed) ? STARTS : fold(n).startsWith(folded) ? STARTS_FOLDED : subsequence(folded, fold(n)) ? LOOSE : null;
    if (tier !== null && (best === null || tier < best)) best = tier;
  }
  return best;
}

/**
 * Discord's order: starting matches before loose ones, which only fill a short list. Within a tier, who posted here
 * last first (standing in for Discord's boost of people the owner talks with), then by name.
 */
function rankPeople(people: Person[], query: string, limit: number): Person[] {
  const sortable = (p: Person): string => fold(p.globalName ?? p.nick ?? p.username);
  const tiered = people.flatMap((p) => {
    const tier = personTier(p, query);
    return tier === null ? [] : [{ p, tier }];
  });
  const order = (a: { p: Person; tier: number }, b: { p: Person; tier: number }): number =>
    a.tier - b.tier || (b.p.lastTs ?? -1) - (a.p.lastTs ?? -1) || sortable(a.p).localeCompare(sortable(b.p));
  return tiered.sort(order).slice(0, limit).map((t) => t.p);
}

/** A role's name against `query`, best first: equal, starts with it, a word does, contains it, loosely. */
function roleTier(name: string, query: string): number | null {
  const n = fold(name);
  const q = fold(query);
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (n.split(/\s+/).some((w) => w.startsWith(q))) return 2;
  if (n.includes(q)) return 3;
  return subsequence(q, n) ? 4 : null;
}

const names = (p: Person): string[] => [p.username, p.nick, p.globalName].filter((n): n is string => n !== null);
const toCandidate = (p: Person): MentionCandidate => ({ kind: 'user', id: p.id, name: p.name, username: p.username, avatar: p.avatar, names: names(p) });

/** The channel's people: its server's known members and everyone who posted in it, with when they last did; not those who left. */
function people(db: Db, channelId: string, guildId: string): Person[] {
  const rows = db
    .prepare(
      `WITH spoke AS (SELECT author_id AS id, MAX(ts) AS lastTs FROM messages WHERE channel_id = @channel GROUP BY author_id),
       -- A webhook posts as an author no one can mention; its newest message says so. Looked up per author: a join
       -- here reads every message of the channel.
       speakers AS (SELECT s.* FROM spoke s WHERE (SELECT ${rawJsonSql('$.webhook_id')} FROM messages m
                    WHERE m.channel_id = @channel AND m.author_id = s.id AND m.ts = s.lastTs LIMIT 1) IS NULL),
       pool AS (SELECT id FROM speakers UNION SELECT user_id FROM members WHERE guild_id = @guild)
       SELECT u.id, u.username, u.global_name AS globalName, u.avatar, mem.nick, mem.roles AS rolesJson, s.lastTs
       FROM pool p JOIN users u ON u.id = p.id
       LEFT JOIN members mem ON mem.guild_id = @guild AND mem.user_id = u.id LEFT JOIN speakers s ON s.id = u.id
       WHERE mem.left_at IS NULL`,
    )
    .all({ channel: channelId, guild: guildId }) as (Omit<Person, 'name' | 'roles'> & { rolesJson: string | null })[];
  return rows.map(({ rolesJson, ...r }) => ({ ...r, name: r.nick ?? r.globalName ?? r.username, roles: rolesJson ? (JSON.parse(rolesJson) as string[]) : null }));
}

/** Who decides access to the channel: the server's owner and roles, and the channel's overwrites (a thread's parent's). */
function accessOf(db: Db, guildId: string, channelId: string): PermissionContext {
  const owner = db.prepare('SELECT owner_id AS ownerId FROM guilds WHERE id = ?').get(guildId) as { ownerId: string | null } | undefined;
  const roles = db.prepare("SELECT id, json_extract(raw_json, '$.permissions') AS permissions FROM roles WHERE guild_id = ?").all(guildId) as { id: string; permissions: unknown }[];
  const ch = db.prepare('SELECT overwrites FROM channels WHERE id = ?').get(channelId) as { overwrites: string | null } | undefined;
  return {
    guildId,
    ownerId: owner?.ownerId ?? null,
    rolePermissions: new Map(roles.map((r) => [r.id, permissionBits(r.permissions)])),
    overwrites: ch?.overwrites ? (JSON.parse(ch.overwrites) as RawOverwrite[]) : [],
  };
}

interface ChannelRow {
  guildId: string;
  kind: number;
  parentId: string | null;
}

/**
 * What to `@` in a channel matching `query`. People who can see it (posting there counts when their roles are
 * unknown); a bare `@` lists who posted last. In a server, then as room remains: mentionable roles (all roles when the
 * owner may mention everyone), and after them @everyone and @here when they may. Listed people, @everyone and @here,
 * then roles, as Discord's list does.
 */
export function mentionCandidates(db: Db, selfId: string | null, channelId: string, query: string, limit: number): MentionCandidate[] {
  const ch = db.prepare('SELECT guild_id AS guildId, kind, parent_id AS parentId FROM channels WHERE id = ?').get(channelId) as ChannelRow | undefined;
  if (!ch) return [];
  const q = query.trim();
  // A DM's people are its own: no roles, @everyone or @here.
  if (ch.guildId === DM_GUILD_ID) return rankPeople(dmPeople(db, channelId, selfId), q, limit).map(toCandidate);
  // A thread, public or private, offers whoever can see its parent: in a private one, mentioning someone adds them.
  const access = accessOf(db, ch.guildId, THREAD_CHANNEL_TYPES.has(ch.kind) && ch.parentId ? ch.parentId : channelId);
  const sees = (p: Person): boolean => (p.roles === null ? p.lastTs !== null : can(access, p.id, p.roles, PERMISSIONS.VIEW_CHANNEL));
  const visible = people(db, channelId, ch.guildId).filter(sees);
  const talked = q ? [] : visible.filter((p) => p.lastTs !== null).sort((a, b) => b.lastTs! - a.lastTs!);
  const users = (talked.length ? talked.slice(0, limit) : rankPeople(visible, q, limit)).map(toCandidate);

  const self = selfId ? (db.prepare('SELECT roles FROM members WHERE guild_id = ? AND user_id = ?').get(ch.guildId, selfId) as { roles: string | null } | undefined) : undefined;
  const everyone = selfId !== null && can(access, selfId, self?.roles ? (JSON.parse(self.roles) as string[]) : [], PERMISSIONS.MENTION_EVERYONE);
  const roleRows = db
    .prepare("SELECT id, name, NULLIF(color, 0) AS color, json_extract(raw_json, '$.mentionable') AS mentionable FROM roles WHERE guild_id = ? AND id != ? ORDER BY position DESC")
    .all(ch.guildId, ch.guildId) as { id: string; name: string; color: number | null; mentionable: number | null }[];
  const roles = roleRows
    .filter((r) => r.mentionable === 1 || everyone)
    .flatMap((r) => {
      const tier = roleTier(r.name, q);
      return tier === null ? [] : [{ r, tier }];
    })
    // Stable: highest role first within a tier.
    .sort((a, b) => a.tier - b.tier)
    .slice(0, Math.max(0, limit - users.length))
    .map(({ r }): MentionCandidate => ({ kind: 'role', id: r.id, name: r.name, color: r.color }));
  let room = limit - users.length - roles.length;
  const globals: MentionCandidate[] = [];
  for (const kind of ['everyone', 'here'] as const) {
    if (!everyone || room <= 0 || !subsequence(fold(q), kind)) continue;
    globals.push({ kind });
    room--;
  }
  return [...users, ...globals, ...roles];
}

/**
 * A DM's people: its current recipients and the owner, from the DM list. A DM stored before recipients were kept falls
 * back to its other person and whoever posted in it.
 */
function dmPeople(db: Db, channelId: string, selfId: string | null): Person[] {
  const rows = db
    .prepare(
      `WITH spoke AS (SELECT author_id AS id, MAX(ts) AS lastTs FROM messages WHERE channel_id = @channel GROUP BY author_id),
       dm AS (SELECT recipients, peer_id FROM channels WHERE id = @channel),
       pool AS (
         SELECT value AS id FROM dm, json_each(dm.recipients) WHERE dm.recipients IS NOT NULL
         UNION SELECT @self WHERE @self IS NOT NULL AND (SELECT recipients FROM dm) IS NOT NULL
         UNION SELECT id FROM spoke WHERE (SELECT recipients FROM dm) IS NULL
         UNION SELECT peer_id FROM dm WHERE recipients IS NULL AND peer_id IS NOT NULL
       )
       SELECT u.id, u.username, u.global_name AS globalName, u.avatar, NULL AS nick, s.lastTs
       FROM pool p JOIN users u ON u.id = p.id LEFT JOIN spoke s ON s.id = u.id`,
    )
    .all({ channel: channelId, self: selfId }) as Omit<Person, 'name' | 'roles'>[];
  return rows.map((r) => ({ ...r, name: r.globalName ?? r.username, roles: null }));
}
