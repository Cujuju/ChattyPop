// DMs and group DMs as the client's gateway reports them (docs/dms.md §3.1, §3.2): merged field by field, scoped to the
// account they belong to, and closed rather than deleted when they leave Discord's list.
import { DM_CHANNEL_TYPE, DM_CHANNEL_TYPES, DM_GROUP_NAME, GROUP_DM_CHANNEL_TYPE, DM_GUILD_ID, privateChannelName, type RawPrivateChannel, type RawUser } from '@shared/discord';
import type { PrivateChannelFacts } from '@shared/dms';
import type { Db } from './db';
import { upsertUser } from './people';

/** The private channel kinds, for SQL `IN (…)`. */
export const PRIVATE_KINDS_SQL = [...DM_CHANNEL_TYPES].join(', ');

/**
 * SQL true when channel alias `c` is one sync keeps current: opted in, and no DM, or a DM of `@self` that isn't a group
 * left. Another account's DM, an unclaimed one, and with `@self` unknown ('') every DM are left out, as in the directory.
 */
export const syncedChannelSql = (c: string): string =>
  `(${c}.opted_in = 1 AND (${c}.kind NOT IN (${PRIVATE_KINDS_SQL}) OR (${c}.account_id = @self AND NOT (${c}.kind = ${GROUP_DM_CHANNEL_TYPE} AND ${c}.closed_at IS NOT NULL))))`;

/**
 * Why `selfId` can't archive `channelId`, or null when it can (any server channel). A DM must be the account's, and
 * neither a message request (read-only) nor a group left (its history can't be read).
 */
export function archiveRefusal(db: Db, channelId: string, selfId: string | null): string | null {
  const r = db
    .prepare(
      `SELECT account_id AS account, kind, closed_at IS NOT NULL AS closed, (is_message_request = 1 OR is_spam = 1) AS request
       FROM channels WHERE id = ? AND kind IN (${PRIVATE_KINDS_SQL})`,
    )
    .get(channelId) as { account: string | null; kind: number; closed: number; request: number } | undefined;
  if (!r) return null;
  if (!selfId || r.account !== selfId) return 'Not a direct message of the account signed in.';
  if (r.request === 1) return 'A message request is read-only here: accept it in Discord first.';
  if (r.kind === GROUP_DM_CHANNEL_TYPE && r.closed === 1) return "You left this group: its history can't be read any more.";
  return null;
}

/** SQL true when snowflake `a` is newer than `b`: a longer id is newer, then digit order. */
export const newerIdSql = (a: string, b: string): string => `(length(${a}) > length(${b}) OR (length(${a}) = length(${b}) AND ${a} > ${b}))`;

/** Applied only when the payload carries the field (`@<flag>`): absent keeps the stored value, null clears it. */
const given = (column: string, flag: string): string => `${column} = CASE WHEN @${flag} THEN excluded.${column} ELSE channels.${column} END`;

/** One of Discord's request flags as stored, or null when the payload left it out (the stored one stands). */
const flagOf = (flag: boolean | undefined): number | null => (flag === undefined ? null : flag ? 1 : 0);

/**
 * The name a payload sets; undefined leaves the stored one. A group's own name stands; a one-to-one DM's, or a group's
 * cleared name (null), follows its people only once the roster is resolved, so an unresolved one never names it.
 */
function nameOf(c: RawPrivateChannel, recipients: RawUser[] | undefined): string | undefined {
  if (c.name) return c.name;
  const followsPeople = c.type === DM_CHANNEL_TYPE || c.name !== undefined;
  return followsPeople && recipients ? privateChannelName({ ...c, name: null, recipients }) : undefined;
}

/**
 * Stores one DM of `accountId` (null: not known yet, the stored account stands). `opened`: Discord lists it now (READY,
 * CHANNEL_CREATE), so it isn't closed. Rank is read from last_message_id at query time, never stored here.
 * Residual: an unnamed group's name follows its roster only when a full channel object arrives (READY, CHANNEL_UPDATE).
 */
export function upsertPrivateChannel(db: Db, accountId: string | null, c: RawPrivateChannel, opened: boolean): void {
  if (!DM_CHANNEL_TYPES.has(c.type)) return;
  db.prepare('INSERT INTO guilds (id, name) VALUES (?, ?) ON CONFLICT(id) DO NOTHING').run(DM_GUILD_ID, DM_GROUP_NAME);
  const recipients = c.recipients?.filter((u) => u.id !== accountId);
  const name = nameOf(c, recipients);
  db.prepare(
    `INSERT INTO channels (id, guild_id, name, kind, account_id, peer_id, recipients, icon, owner_id, last_message_id, is_message_request, is_spam)
     VALUES (@id, @guild, @name, @kind, @account, @peer, @recipients, @icon, @owner, @last, COALESCE(@messageRequest, 0), COALESCE(@spam, 0))
     ON CONFLICT(id) DO UPDATE SET guild_id = excluded.guild_id, kind = excluded.kind, ${given('name', 'nameKnown')},
       account_id = COALESCE(excluded.account_id, channels.account_id), ${given('peer_id', 'rosterKnown')},
       ${given('recipients', 'rosterKnown')},
       ${given('icon', 'iconKnown')}, ${given('owner_id', 'ownerKnown')},
       last_message_id = CASE WHEN channels.last_message_id IS NULL OR (excluded.last_message_id IS NOT NULL
         AND ${newerIdSql('excluded.last_message_id', 'channels.last_message_id')}) THEN COALESCE(excluded.last_message_id, channels.last_message_id)
         ELSE channels.last_message_id END,
       is_message_request = COALESCE(@messageRequest, channels.is_message_request), is_spam = COALESCE(@spam, channels.is_spam),
       closed_at = CASE WHEN @opened THEN NULL ELSE channels.closed_at END`,
  ).run({
    id: c.id,
    guild: DM_GUILD_ID,
    // A new row needs a name even when the payload sets none.
    name: name ?? privateChannelName({ ...c, recipients }),
    nameKnown: name !== undefined ? 1 : 0,
    kind: c.type,
    account: accountId,
    // A one-to-one DM's other person, still written: older builds read it.
    peer: c.type === DM_CHANNEL_TYPE ? (recipients?.[0]?.id ?? null) : null,
    // The roster: every member but self, owner included (JSON user ids; NULL while unknown).
    recipients: recipients ? JSON.stringify(recipients.map((u) => u.id)) : null,
    rosterKnown: recipients !== undefined ? 1 : 0,
    icon: c.icon ?? null,
    iconKnown: c.icon !== undefined ? 1 : 0,
    owner: c.owner_id ?? null,
    ownerKnown: c.owner_id !== undefined ? 1 : 0,
    last: c.last_message_id ?? null,
    messageRequest: flagOf(c.is_message_request),
    spam: flagOf(c.is_spam),
    opened: opened ? 1 : 0,
  });
  recipients?.forEach((u) => upsertUser(db, u));
}

/**
 * READY's list for `accountId`: each listed DM is open and the account's, claimed if no account owned it (an older build
 * stored it). Unless `partial`, the account's unlisted DMs close at `now`, and so does an unlisted unowned DM holding a
 * message the account wrote, claimed first. Any other unowned DM stays unowned, hidden from every DM list.
 */
export function replacePrivateChannels(db: Db, accountId: string, channels: RawPrivateChannel[], partial: boolean, now: number): void {
  db.transaction(() => {
    const listed = channels.filter((c) => DM_CHANNEL_TYPES.has(c.type));
    for (const c of listed) upsertPrivateChannel(db, accountId, c, true);
    if (partial) return;
    const params = { account: accountId, now, listed: JSON.stringify(listed.map((c) => c.id)) };
    db.prepare(
      `UPDATE channels SET account_id = @account WHERE kind IN (${PRIVATE_KINDS_SQL}) AND account_id IS NULL
       AND id NOT IN (SELECT value FROM json_each(@listed))
       AND EXISTS (SELECT 1 FROM messages m WHERE m.channel_id = channels.id AND m.author_id = @account)`,
    ).run(params);
    db.prepare(
      `UPDATE channels SET closed_at = @now WHERE kind IN (${PRIVATE_KINDS_SQL}) AND account_id = @account AND closed_at IS NULL
       AND id NOT IN (SELECT value FROM json_each(@listed))`,
    ).run(params);
  })();
}

/** What a new message did to its DM: its newest id rose; a closed one-to-one DM opened again. */
export interface Touch {
  rose: boolean;
  reopened: boolean;
}

/**
 * A new message in a known DM: its newest id rises to `messageId`, never falls. A closed one-to-one DM opens again, as
 * Discord reopens it; a closed group stays closed (no message reaches one left).
 */
export function touchChannel(db: Db, channelId: string, messageId: string): Touch {
  const row = db
    .prepare(
      `SELECT last_message_id IS NULL OR ${newerIdSql('@message', 'last_message_id')} AS rose, kind = @dm AND closed_at IS NOT NULL AS reopened
       FROM channels WHERE id = @channel AND kind IN (${PRIVATE_KINDS_SQL})`,
    )
    .get({ channel: channelId, message: messageId, dm: DM_CHANNEL_TYPE }) as { rose: number; reopened: number } | undefined;
  const touch = { rose: row?.rose === 1, reopened: row?.reopened === 1 };
  if (touch.rose || touch.reopened) {
    db.prepare(
      `UPDATE channels SET last_message_id = CASE WHEN @rose THEN @message ELSE last_message_id END,
         closed_at = CASE WHEN @reopened THEN NULL ELSE closed_at END WHERE id = @channel`,
    ).run({ channel: channelId, message: messageId, rose: touch.rose ? 1 : 0, reopened: touch.reopened ? 1 : 0 });
  }
  return touch;
}

/** Discord dropped the DM from its list (closed, left, removed): kept, marked closed at `now`. */
export function closePrivateChannel(db: Db, channelId: string, now: number): boolean {
  return db.prepare(`UPDATE channels SET closed_at = ? WHERE id = ? AND kind IN (${PRIVATE_KINDS_SQL}) AND closed_at IS NULL`).run(now, channelId).changes > 0;
}

/** `channelId` as a write checks it: a DM or group DM of `selfId`; null for any other channel, or while no self is known. */
export function privateChannelFacts(db: Db, channelId: string, selfId: string | null): PrivateChannelFacts | null {
  if (!selfId) return null;
  const r = db
    .prepare(
      `SELECT kind, closed_at IS NOT NULL AS closed, recipients, owner_id AS ownerId, (is_message_request = 1 OR is_spam = 1) AS request
       FROM channels WHERE id = ? AND kind IN (${PRIVATE_KINDS_SQL}) AND account_id = ?`,
    )
    .get(channelId, selfId) as { kind: number; closed: number; recipients: string | null; ownerId: string | null; request: number } | undefined;
  return r
    ? { kind: r.kind, closed: r.closed === 1, recipients: r.recipients ? (JSON.parse(r.recipients) as string[]) : null, ownerId: r.ownerId, request: r.request === 1 }
    : null;
}

/** Every stored DM and group DM, of any account or none. */
export function privateChannelIds(db: Db): string[] {
  return (db.prepare(`SELECT id FROM channels WHERE kind IN (${PRIVATE_KINDS_SQL})`).all() as { id: string }[]).map((r) => r.id);
}

/** `selfId`'s open one-to-one DM with `userId`, as Discord's client has it at hand; null when there is none. */
export function openDmWith(db: Db, userId: string, selfId: string | null): string | null {
  if (!selfId) return null;
  const r = db
    .prepare('SELECT id FROM channels WHERE kind = ? AND account_id = ? AND peer_id = ? AND closed_at IS NULL ORDER BY length(id) DESC, id DESC LIMIT 1')
    .get(DM_CHANNEL_TYPE, selfId, userId) as { id: string } | undefined;
  return r?.id ?? null;
}

/** The newest message Discord reports in `selfId`'s DM; null when it has none; undefined when it isn't `selfId`'s DM. */
export function dmLastMessageId(db: Db, channelId: string, selfId: string | null): string | null | undefined {
  if (!selfId) return undefined;
  const r = db.prepare(`SELECT last_message_id AS id FROM channels WHERE id = ? AND kind IN (${PRIVATE_KINDS_SQL}) AND account_id = ?`).get(channelId, selfId) as
    | { id: string | null }
    | undefined;
  return r ? r.id : undefined;
}

/** The owner stopped (or declined) archiving a DM, so auto-archive skips it; archiving it again clears that. */
export function setAutoDeclined(db: Db, channelId: string, declined: boolean): void {
  db.prepare(`UPDATE channels SET auto_declined = ? WHERE id = ? AND kind IN (${PRIVATE_KINDS_SQL})`).run(declined ? 1 : 0, channelId);
}

/**
 * Auto-archive's gate (docs/dms.md §3.6): a DM of `selfId`, not archived, not a request or spam, not declined by the
 * owner, and not a group left. Unknown DMs and other accounts' never qualify.
 */
export function autoArchivable(db: Db, channelId: string, selfId: string | null): boolean {
  if (!selfId) return false;
  return (
    db
      .prepare(
        `SELECT 1 FROM channels WHERE id = ? AND kind IN (${PRIVATE_KINDS_SQL}) AND account_id = ? AND opted_in = 0 AND auto_declined = 0
         AND is_message_request = 0 AND is_spam = 0 AND NOT (kind = ? AND closed_at IS NOT NULL)`,
      )
      .get(channelId, selfId, GROUP_DM_CHANNEL_TYPE) !== undefined
  );
}

/** A person joined or left a known DM; the signed-in user (`selfId`) is never on its roster. Returns whether it changed. */
export function changeRecipient(db: Db, channelId: string, user: RawUser, added: boolean, selfId: string | null): boolean {
  if (user.id === selfId) return false;
  const row = db.prepare(`SELECT recipients FROM channels WHERE id = ? AND kind IN (${PRIVATE_KINDS_SQL})`).get(channelId) as
    | { recipients: string | null }
    | undefined;
  // An unknown roster stays unknown: one person's change doesn't make it whole.
  if (!row?.recipients) return false;
  const before = JSON.parse(row.recipients) as string[];
  const after = added ? [...new Set([...before, user.id])] : before.filter((id) => id !== user.id);
  if (after.length === before.length) return false;
  if (added) upsertUser(db, user);
  db.prepare('UPDATE channels SET recipients = ? WHERE id = ?').run(JSON.stringify(after), channelId);
  return true;
}
