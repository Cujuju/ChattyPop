// Host message text.
import type { Db } from '../db';
import { ARRIVAL, type Arrival, type Arrived, type TextMessage } from '../arrival';

/**
 * SQL for a message's text as AI consumers read it: its content, then its derived texts (transcripts)
 * in order. Unmarked, so a marker word can't match topic patterns. `m` is the messages alias.
 */
export const MESSAGE_TEXT_SQL = `COALESCE((SELECT group_concat(part, char(10)) FROM (
                                    SELECT 0 AS k, m.content AS part WHERE m.content != ''
                                    UNION ALL SELECT d.ord, d.text FROM derived_texts d WHERE d.message_id = m.id AND d.text != '' ORDER BY k)), '')`;

/**
 * SQL for the text of link row alias `l`, null when it has none: a plugin's text for it (a fetched X post, link_texts),
 * else Discord's preview title and description. The plugin's wins: it is the full text.
 */
export const linkTextSql = (l: string): string => `COALESCE(
  (SELECT t.text FROM link_texts t WHERE t.url = ${l}.url AND t.text != '' ORDER BY t.rowid LIMIT 1),
  NULLIF(trim(COALESCE(${l}.title, '') || char(10) || COALESCE(${l}.description, ''), char(10) || ' '), ''))`;

/** Each link of message `messageId` (an SQL expression) with its text (linkTextSql). */
const linkTextsSql = (messageId: string): string => `SELECT ml.link_id AS k, ${linkTextSql('l')} AS text
                        FROM message_links ml JOIN links l ON l.id = ml.link_id
                        WHERE ml.message_id = ${messageId}`;

/** SQL for the text of the posts and pages message `m` links to, one link per line; '' when none has any. */
export const LINKED_TEXT_SQL = `COALESCE((SELECT group_concat(text, char(10)) FROM (${linkTextsSql('m.id')} ORDER BY k)), '')`;

/** A message's own columns (a PluginMessage) for messages alias `m`, without what it links to. */
export const MESSAGE_ROW_COLUMNS = `m.id, m.channel_id AS channelId, m.author_id AS authorId, m.ts, ${MESSAGE_TEXT_SQL} AS content`;

/** Columns of a TextMessage for messages alias `m`: SELECT them, then FROM messages m. */
export const TEXT_MESSAGE_COLUMNS = `${MESSAGE_ROW_COLUMNS}, ${LINKED_TEXT_SQL} AS linked`;

/** One stored message with its full text; undefined when not archived. */
export function textMessage(db: Db, messageId: string): TextMessage | undefined {
  return db
    .prepare(`SELECT ${TEXT_MESSAGE_COLUMNS} FROM messages m WHERE m.id = ?`)
    .get(messageId) as TextMessage | undefined;
}

/** How many of a message's links have text; a rise means linked text arrived after the message did. */
export function textedLinkCount(db: Db, messageId: string): number {
  return db.prepare(`SELECT COUNT(text) FROM (${linkTextsSql('?')})`).pluck().get(messageId) as number;
}

/**
 * The arrival of text added to a stored message after it arrived (a transcript, a link's text): how its message first
 * arrived, timed `at`, as its first text (not an edit). A message stored before arrivals were recorded counts as fetched,
 * so its added text is never live.
 */
export function addedTextArrival(db: Db, messageId: string, at: number): Arrived {
  const via = db.prepare('SELECT arrived_via FROM messages WHERE id = ?').pluck().get(messageId) as Arrival | null | undefined;
  return { via: via ?? ARRIVAL.sync, at, edit: false };
}

/** A requested message count as asked for: at least 1, at most max. */
export const clampCount = (n: number, max: number): number => Math.min(Math.max(1, Math.round(n)), max);

/** Throws unless `fromTs` is before `toTs` (NaN fails too). */
export function assertRange(fromTs: number, toTs: number): void {
  if (!(fromTs < toTs)) throw new Error('Pick a start before the end.');
}
