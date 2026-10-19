// Caches eligible mention pools until message/name/access changes. Ranks people before everyone/here and roles within the shared limit.
import type { MentionCandidate } from '@shared/contract';
import { DM_GUILD_ID, THREAD_CHANNEL_TYPES } from '@shared/discord';
import { foldName as fold, subsequence } from '@shared/nameMatch';
import { can, permissionBits, PERMISSIONS, type MemberFacts, type PermissionContext, type RawOverwrite } from '@shared/permissions';
import type { Db } from '../db';
import { nameWriteCount } from '../nameWrites';
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

/** A person with their names as matching reads them, computed once per pool. */
interface Ranked extends Person {
  lower: string[];
  folded: string[];
  sortable: string;
}

const names = (p: Person): string[] => [p.username, p.nick, p.globalName].filter((n): n is string => n !== null);
const toCandidate = (p: Person): MentionCandidate => ({ kind: 'user', id: p.id, name: p.name, username: p.username, avatar: p.avatar, names: names(p) });
const ranked = (p: Person): Ranked => {
  const all = names(p);
  return { ...p, lower: all.map((n) => n.toLocaleLowerCase()), folded: all.map(fold), sortable: fold(p.globalName ?? p.nick ?? p.username) };
};

/** How a person's names match `query`, best first: one starts with it as typed (0), once folded (1), loosely (2). */
const STARTS = 0;
const STARTS_FOLDED = 1;
const LOOSE = 2;
function personTier(p: Ranked, typed: string, folded: string): number | null {
  let best: number | null = null;
  p.lower.forEach((lower, i) => {
    const name = p.folded[i]!;
    const tier = lower.startsWith(typed) ? STARTS : name.startsWith(folded) ? STARTS_FOLDED : subsequence(folded, name) ? LOOSE : null;
    if (tier !== null && (best === null || tier < best)) best = tier;
  });
  return best;
}

/** Ranks prefix matches before loose matches, then recent posters and names. Maintains only the best limit candidates. */
function rankPeople(people: readonly Ranked[], query: string, limit: number): Ranked[] {
  const typed = query.toLocaleLowerCase();
  const folded = fold(query);
  type Entry = { p: Ranked; tier: number };
  const order = (a: Entry, b: Entry): number => a.tier - b.tier || (b.p.lastTs ?? -1) - (a.p.lastTs ?? -1) || a.p.sortable.localeCompare(b.p.sortable);
  const best: Entry[] = [];
  for (const p of people) {
    const tier = personTier(p, typed, folded);
    if (tier === null) continue;
    const entry = { p, tier };
    if (best.length === limit && order(entry, best[limit - 1]!) >= 0) continue;
    const at = best.findIndex((b) => order(entry, b) < 0);
    best.splice(at === -1 ? best.length : at, 0, entry);
    if (best.length > limit) best.pop();
  }
  return best.map((b) => b.p);
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

/** A member's roles and timeout in a server, as permissions read them; none known reads as no roles. */
export function memberFacts(db: Db, guildId: string, userId: string): MemberFacts {
  const row = db.prepare('SELECT roles, timed_out_until AS timedOutUntil FROM members WHERE guild_id = ? AND user_id = ?').get(guildId, userId) as
    | { roles: string | null; timedOutUntil: number | null }
    | undefined;
  return { roles: row?.roles ? (JSON.parse(row.roles) as string[]) : [], timedOutUntil: row?.timedOutUntil ?? null };
}

/** What decides access across a server: its owner and roles' permissions. */
type ServerAccess = Pick<PermissionContext, 'guildId' | 'ownerId' | 'rolePermissions'>;

function serverAccess(db: Db, guildId: string): ServerAccess {
  const owner = db.prepare('SELECT owner_id AS ownerId FROM guilds WHERE id = ?').get(guildId) as { ownerId: string | null } | undefined;
  const roles = db.prepare("SELECT id, json_extract(raw_json, '$.permissions') AS permissions FROM roles WHERE guild_id = ?").all(guildId) as { id: string; permissions: unknown }[];
  return { guildId, ownerId: owner?.ownerId ?? null, rolePermissions: new Map(roles.map((r) => [r.id, permissionBits(r.permissions)])) };
}

/** `server`'s access with the channel's overwrites (a thread's parent's). */
function withOverwrites(db: Db, server: ServerAccess, channelId: string, thread: boolean): PermissionContext {
  const ch = db.prepare('SELECT overwrites FROM channels WHERE id = ?').get(channelId) as { overwrites: string | null } | undefined;
  return { ...server, overwrites: ch?.overwrites ? (JSON.parse(ch.overwrites) as RawOverwrite[]) : [], thread };
}

/** Who decides access to the channel: the server's owner and roles, and the channel's overwrites (a thread's parent's). */
export const accessOf = (db: Db, guildId: string, channelId: string, thread: boolean): PermissionContext =>
  withOverwrites(db, serverAccess(db, guildId), channelId, thread);

interface ChannelRow {
  guildId: string;
  kind: number;
  parentId: string | null;
}

/** A channel's people who can see it, ready to rank, and what decides access there. */
interface Pool {
  /** nameWriteCount when read: a name or access write since makes it stale. */
  writes: number;
  access: PermissionContext;
  visible: Ranked[];
  /** Those who posted here, latest first: what a bare `@` lists. */
  talked: Ranked[];
}

/** Pools kept per database, by channel: a few, as the owner types in a few channels at once. */
const POOLS_KEPT = 8;
const pools = new WeakMap<Db, Map<string, Pool>>();
/** Channels whose messages changed since their pool was read; '' when any channel's may have. */
let staleChannels = new Set<string>();

/** `channelId`'s messages changed ('' when some channel's may have): its pool is read again when next asked. */
export function forgetMentionPools(channelId: string): void {
  staleChannels.add(channelId);
}

const CHANNEL_SQL = 'SELECT guild_id AS guildId, kind, parent_id AS parentId FROM channels WHERE id = ?';

/** The channel whose overwrites decide who sees `channelId`: a thread, public or private, its parent's (in a private one, mentioning someone adds them). */
function accessChannel(ch: ChannelRow, channelId: string): { id: string; thread: boolean } {
  const thread = THREAD_CHANNEL_TYPES.has(ch.kind) && ch.parentId !== null;
  return { id: thread ? ch.parentId! : channelId, thread };
}

/** Members who see any of a set of channels, kept per database for the last set asked: a search asks again per keystroke. */
const seers = new WeakMap<Db, { key: string; writes: number; ids: { id: string; guildId: string }[] }>();

/**
 * Current members, by server, who can see any of `channelIds`: the people a composer's pool holds who need not have posted.
 * One whose roles the server's member list hasn't named is left out, as the pool leaves them out unless they posted.
 */
export function membersWhoSee(db: Db, channelIds: readonly string[]): { id: string; guildId: string }[] {
  const key = channelIds.join();
  const writes = nameWriteCount(db);
  const hit = seers.get(db);
  if (hit && hit.key === key && hit.writes === writes) return hit.ids;
  // By server, the channels deciding access, each once: threads share their parent's.
  const byGuild = new Map<string, Map<string, boolean>>();
  const channel = db.prepare(CHANNEL_SQL);
  for (const id of channelIds) {
    const ch = channel.get(id) as ChannelRow | undefined;
    if (!ch || ch.guildId === DM_GUILD_ID) continue;
    const target = accessChannel(ch, id);
    byGuild.set(ch.guildId, (byGuild.get(ch.guildId) ?? new Map<string, boolean>()).set(target.id, target.thread));
  }
  const members = db.prepare('SELECT user_id AS id, roles FROM members WHERE guild_id = ? AND left_at IS NULL AND roles IS NOT NULL');
  const ids = [...byGuild].flatMap(([guildId, targets]) => {
    const server = serverAccess(db, guildId);
    const accesses = [...targets].map(([id, thread]) => withOverwrites(db, server, id, thread));
    return (members.all(guildId) as { id: string; roles: string }[])
      .filter((m) => {
        const facts = { roles: JSON.parse(m.roles) as string[] };
        return accesses.some((access) => can(access, m.id, facts, PERMISSIONS.VIEW_CHANNEL));
      })
      .map((m) => ({ id: m.id, guildId }));
  });
  if (writes !== null) seers.set(db, { key, writes, ids });
  return ids;
}

function poolOf(db: Db, ch: ChannelRow, channelId: string): Pool {
  const kept = pools.get(db) ?? new Map<string, Pool>();
  pools.set(db, kept);
  if (staleChannels.has('')) kept.clear();
  else for (const id of staleChannels) kept.delete(id);
  staleChannels = new Set();
  const writes = nameWriteCount(db);
  const hit = kept.get(channelId);
  if (hit && hit.writes === writes) return hit;
  const target = accessChannel(ch, channelId);
  const access = accessOf(db, ch.guildId, target.id, target.thread);
  const sees = (p: Person): boolean => (p.roles === null ? p.lastTs !== null : can(access, p.id, { roles: p.roles }, PERMISSIONS.VIEW_CHANNEL));
  const visible = people(db, channelId, ch.guildId).filter(sees).map(ranked);
  const talked = visible.filter((p) => p.lastTs !== null).sort((a, b) => b.lastTs! - a.lastTs!);
  if (writes === null) return { writes: -1, access, visible, talked };
  const pool = { writes, access, visible, talked };
  kept.delete(channelId);
  kept.set(channelId, pool);
  if (kept.size > POOLS_KEPT) kept.delete(kept.keys().next().value!);
  return pool;
}

/** Suggests eligible channel members, then permitted roles/everyone/here within capacity. Display order is people, everyone/here, roles; bare queries prioritize recent posters. */
export function mentionCandidates(db: Db, selfId: string | null, channelId: string, query: string, limit: number): MentionCandidate[] {
  const ch = db.prepare(CHANNEL_SQL).get(channelId) as ChannelRow | undefined;
  if (!ch) return [];
  const q = query.trim();
  // A DM's people are its own: no roles, @everyone or @here.
  if (ch.guildId === DM_GUILD_ID) return rankPeople(dmPeople(db, channelId, selfId).map(ranked), q, limit).map(toCandidate);
  const { access, visible, talked } = poolOf(db, ch, channelId);
  const users = (!q && talked.length ? talked.slice(0, limit) : rankPeople(visible, q, limit)).map(toCandidate);

  // Mentioning everyone takes that right, the right to send here and no timeout (shared/permissions.ts).
  const everyone = selfId !== null && can(access, selfId, memberFacts(db, ch.guildId, selfId), PERMISSIONS.MENTION_EVERYONE);
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

/** DM mention pools include current recipients and owner. Legacy DMs fall back to peer and message authors. */
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
