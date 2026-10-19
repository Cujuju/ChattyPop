// Stable, read-only plugin archive contracts; privacy is evaluated by SQLite at read time.
import { THREAD_CHANNEL_TYPES } from '@shared/discord';
import type { Db } from './db';
import { MESSAGE_TEXT_SQL, LINKED_TEXT_SQL } from './queries/messageText';
import { displayNameSql, plainNameSql } from './queries/names';
import { attachmentKindSql } from './queries/attachmentKind';
import { archiveLinksSql } from './queries/linkMetadata';
import { NOTHING_HIDDEN_SQL, visibleChannelSql, visibleMessageRefSql, visibleMessageSql } from './queries/privacy';
import { installRollupReferences, messageResidualSql } from './rollups/privacy';

const messages = `SELECT m.id, m.seq, m.channel_id, m.author_id, m.ts, m.edited_ts, m.deleted_at, m.pruned_at,
  m.content, m.raw_json, m.arrived_via, ${MESSAGE_TEXT_SQL} AS text, ${LINKED_TEXT_SQL} AS linked,
  ${displayNameSql('m.author_id', 'm.channel_id')} AS author_name, ${plainNameSql('m.author_id')} AS author_plain_name,
  COALESCE((SELECT group_concat(text, char(10)) FROM (SELECT text FROM derived_texts WHERE message_id = m.id AND text != '' ORDER BY ord)), '') AS transcript,
  COALESCE(u.username, m.author_id) AS username,
  (SELECT guild_id FROM channels WHERE id = m.channel_id) AS guild_id
  FROM messages m LEFT JOIN users u ON u.id = m.author_id`;
const channels = `SELECT c.id, c.guild_id, c.name, c.kind, c.parent_id, c.opted_in, c.kind IN (${[...THREAD_CHANNEL_TYPES].join(', ')}) AS is_thread FROM channels c`;
const guilds = 'SELECT id, name, icon FROM guilds';
const users = 'SELECT id, username, global_name, avatar, COALESCE(global_name, username, id) AS display_name FROM users';
const attachments = `SELECT id, message_id, channel_id, filename, content_type, size, width, height,
  url, sha256, status, error, stored_bytes, stored_ext, compressed_at, removed_at, ts,
  ${attachmentKindSql('content_type', 'filename')} AS kind FROM attachments`;
const rules = 'SELECT id, name, builtin AS managed_key FROM rules';
const shares = 'SELECT message_id, link_id FROM message_links';
const derivedTexts = 'SELECT seq, message_id, source, ord, text, part FROM derived_texts d';
const search = 'SELECT rowid AS seq, fts_messages AS query, rank FROM fts_messages';
const names = `SELECT c.id AS channel_id, mem.user_id, mem.nick AS name
  FROM members mem JOIN channels c ON c.guild_id = mem.guild_id`;
const conversationLinks = 'SELECT l.message_id, l.channel_id, l.ts, l.parent_id, l.kind, l.confidence FROM conversation_links l';

/** Managed archive_* views use explicit columns. openDb installs current definitions after migrations and removes retired views. */
export const ARCHIVE_VIEWS: Readonly<Record<string, string>> = {
  archive_all_messages: messages,
  archive_messages: `${messages} WHERE ${visibleMessageSql('m')}`,
  archive_all_rollup_messages: `${messages} WHERE m.id NOT IN (SELECT message_id FROM rollup_reference_messages)`,
  archive_rollup_messages: `${messages} WHERE m.id NOT IN (SELECT message_id FROM rollup_reference_messages) AND ${visibleMessageSql('m')}`,
  archive_residual_messages: `SELECT m.* FROM rollup_reference_messages rr CROSS JOIN (${messages}) m ON m.id = rr.message_id WHERE ${visibleMessageSql('m')}`,
  archive_all_channels: channels,
  archive_channels: `${channels} WHERE ${visibleChannelSql('c.id')}`,
  archive_all_guilds: guilds,
  archive_guilds: `${guilds} WHERE id NOT IN (SELECT id FROM hidden_ids)`,
  archive_users: users,
  archive_all_attachments: attachments,
  archive_attachments: `${attachments} WHERE ${visibleMessageRefSql('channel_id', 'message_id')}`,
  archive_all_rollup_attachments: `${attachments} WHERE NOT ${messageResidualSql('message_id')}`,
  archive_rollup_attachments: `${attachments} WHERE NOT ${messageResidualSql('message_id')} AND ${visibleChannelSql('channel_id')}`,
  archive_residual_attachments: `${attachments} WHERE ${messageResidualSql('message_id')} AND ${visibleMessageRefSql('channel_id', 'message_id')}`,
  archive_all_derived_texts: derivedTexts,
  archive_derived_texts: `${derivedTexts} WHERE EXISTS (SELECT 1 FROM messages m WHERE m.id = d.message_id AND ${visibleMessageSql('m')})`,
  archive_rules: rules,
  archive_all_links: archiveLinksSql('1', true),
  archive_links: archiveLinksSql(),
  archive_all_rollup_links: `SELECT * FROM (${archiveLinksSql('1', true)}) rl
    WHERE rl.id NOT IN (SELECT link_id FROM rollup_reference_links) AND NOT ${messageResidualSql('rl.first_message_id')}`,
  archive_residual_links: `SELECT * FROM (${archiveLinksSql()}) rl
    WHERE rl.id IN (SELECT link_id FROM rollup_reference_links) OR ${messageResidualSql('rl.first_message_id')}`,
  archive_all_message_links: shares,
  archive_message_links: `${shares}
    WHERE ${NOTHING_HIDDEN_SQL} OR NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = message_id AND NOT ${visibleMessageSql('m')})`,
  archive_all_search: search,
  archive_search: `${search} WHERE rowid IN (SELECT seq FROM archive_messages)`,
  archive_all_names: names,
  archive_names: `${names} WHERE ${visibleChannelSql('c.id')}`,
  archive_all_conversation_links: conversationLinks,
  // A hidden parent drops the link, so conversations never pass through a hidden message.
  archive_conversation_links: `${conversationLinks} WHERE EXISTS (SELECT 1 FROM messages m WHERE m.id = l.message_id AND ${visibleMessageSql('m')})
    AND (l.parent_id IS NULL OR NOT EXISTS (SELECT 1 FROM messages p WHERE p.id = l.parent_id AND NOT ${visibleMessageSql('p')}))`,
};

/** A managed view's CREATE statement, exactly as sqlite_schema stores it. */
export const archiveViewSql = (name: string): string => `CREATE VIEW ${name} AS ${ARCHIVE_VIEWS[name]}`;

/** The stored managed views, current or retired: name → CREATE statement. */
function storedArchiveViews(db: Db): Map<string, string> {
  const rows = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'view' AND name GLOB 'archive_*'").all() as { name: string; sql: string }[];
  return new Map(rows.map((r) => [r.name, r.sql]));
}

/** Drops every managed view, so ALTER TABLE (which reparses every view) never meets a stale one. */
export function dropArchiveViews(db: Db): void {
  for (const name of storedArchiveViews(db).keys()) db.exec(`DROP VIEW "${name}"`);
}

/** Reconciles managed views and checks binding inside the caller transaction. Unchanged views require no writes; invalid definitions fail the transaction. */
export function installArchiveViews(db: Db): void {
  installRollupReferences(db);
  const stored = storedArchiveViews(db);
  for (const name of stored.keys()) if (!Object.hasOwn(ARCHIVE_VIEWS, name)) db.exec(`DROP VIEW "${name}"`);
  for (const name of Object.keys(ARCHIVE_VIEWS)) {
    const sql = archiveViewSql(name);
    if (stored.get(name) === sql) continue;
    db.exec(`DROP VIEW IF EXISTS "${name}"; ${sql}`);
    db.prepare(`SELECT * FROM "${name}" LIMIT 0`);
  }
}
