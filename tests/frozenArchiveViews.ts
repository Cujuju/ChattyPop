// Frozen archive views for intermediate-schema tests; independent of the current registry.
import type { Db } from '../src/core/db';

/** The check that nothing is hidden, which guards the per-row scope checks. */
const NOTHING_HIDDEN = 'NOT EXISTS (SELECT 1 FROM hidden_ids)';
const VISIBLE_M = `(m.channel_id NOT IN (SELECT id FROM hidden_channels) AND (${NOTHING_HIDDEN} OR NOT EXISTS (SELECT 1 FROM hidden_ids h WHERE instr(m.content, h.id) > 0)))`;

/** The privacy-filtered views the scope-table parity test reads, as persisted before HIDDEN_SCOPE_TABLE. */
export const VIEWS_BEFORE_SCOPE_TABLE: Readonly<Record<string, string>> = {
  archive_messages: `SELECT m.id, m.seq, m.channel_id, m.author_id, m.ts, m.edited_ts, m.deleted_at, m.pruned_at, m.content, m.raw_json, m.arrived_via,
    COALESCE((SELECT group_concat(part, char(10)) FROM (SELECT 0 AS k, m.content AS part WHERE m.content != ''
      UNION ALL SELECT d.ord, d.text FROM derived_texts d WHERE d.message_id = m.id AND d.text != '' ORDER BY k)), '') AS text,
    COALESCE((SELECT group_concat(text, char(10)) FROM (SELECT ml.link_id AS k, COALESCE(
      (SELECT t.text FROM link_texts t WHERE t.url = l.url AND t.text != '' ORDER BY t.rowid LIMIT 1),
      NULLIF(trim(COALESCE(l.title, '') || char(10) || COALESCE(l.description, ''), char(10) || ' '), '')) AS text
      FROM message_links ml JOIN links l ON l.id = ml.link_id WHERE ml.message_id = m.id ORDER BY k)), '') AS linked,
    COALESCE((SELECT mem.nick FROM members mem JOIN channels mc ON mc.guild_id = mem.guild_id WHERE mc.id = m.channel_id AND mem.user_id = m.author_id),
      u.global_name, u.username, m.author_id) AS author_name,
    COALESCE(u.global_name, u.username, m.author_id) AS author_plain_name,
    COALESCE((SELECT group_concat(text, char(10)) FROM (SELECT text FROM derived_texts WHERE message_id = m.id AND text != '' ORDER BY ord)), '') AS transcript,
    COALESCE(u.username, m.author_id) AS username,
    (SELECT guild_id FROM channels WHERE id = m.channel_id) AS guild_id
    FROM messages m LEFT JOIN users u ON u.id = m.author_id WHERE ${VISIBLE_M}`,
  archive_channels: `SELECT c.id, c.guild_id, c.name, c.kind, c.parent_id, c.opted_in, c.kind IN (10, 11, 12) AS is_thread
    FROM channels c WHERE c.id NOT IN (SELECT id FROM hidden_channels)`,
  archive_guilds: 'SELECT id, name, icon FROM guilds WHERE id NOT IN (SELECT id FROM hidden_ids)',
  archive_links: `SELECT l.id, l.url, l.platform, l.title, l.description, l.thumbnail_url, l.site,
    l.first_message_id, l.first_channel_id, l.first_author_id, l.first_ts,
    COALESCE((SELECT mem.nick FROM members mem JOIN channels mc ON mc.guild_id = mem.guild_id WHERE mc.id = l.first_channel_id AND mem.user_id = l.first_author_id),
      u.global_name, u.username, l.first_author_id) AS author_name
    FROM links l LEFT JOIN users u ON u.id = l.first_author_id
    WHERE (l.first_channel_id NOT IN (SELECT id FROM hidden_channels) AND (${NOTHING_HIDDEN} OR NOT EXISTS (SELECT 1 FROM messages hm
      WHERE hm.id = l.first_message_id AND EXISTS (SELECT 1 FROM hidden_ids h WHERE instr(hm.content, h.id) > 0))))
      AND (${NOTHING_HIDDEN} OR NOT EXISTS (SELECT 1 FROM hidden_ids h WHERE instr(l.url, h.id) > 0))`,
  archive_message_links: `SELECT message_id, link_id FROM message_links
    WHERE ${NOTHING_HIDDEN} OR NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = message_id AND NOT ${VISIBLE_M})`,
  archive_names: `SELECT c.id AS channel_id, mem.user_id, mem.nick AS name
    FROM members mem JOIN channels c ON c.guild_id = mem.guild_id WHERE c.id NOT IN (SELECT id FROM hidden_channels)`,
};

/** archive_messages as persisted before its scope checks were guarded: the scope is derived for every message. */
export const UNGUARDED_MESSAGES = VIEWS_BEFORE_SCOPE_TABLE.archive_messages!.replaceAll(`${NOTHING_HIDDEN} OR `, '');

/** Persists frozen view definitions as name-to-SELECT mappings. */
export function persistViews(db: Db, views: Readonly<Record<string, string>>): void {
  for (const [name, select] of Object.entries(views)) db.exec(`CREATE VIEW ${name} AS ${select}`);
}
