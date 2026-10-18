// Stored conversation links, the per-channel queue of message ranges to (re)link, and the inputs the linker reads.
import { MS_PER_MIN } from '@shared/units';
import type { Db } from '../db';
import { REPLY_MESSAGE_TYPE, USER_MENTION } from '../queries/messageExtras';
import { LINK_KIND, type Link, type LinkInput } from './linker';

/** A channel's gap covers this share of its replies' delays (three in four); the reply-holdout score tunes it. */
export const PACE_PERCENTILE = 0.75;
/** Newest replies sampled for a channel's pace. */
export const PACE_SAMPLE = 200;
/** Fewer replies than this give no reliable pace: the archive-wide one is used. */
export const PACE_MIN_REPLIES = 20;
/** Before enough replies are linked anywhere: the fixed gap the earlier conversation view used. */
export const PACE_FALLBACK_MS = 5 * MS_PER_MIN;

/** One payload decode per row: the reply target, when the message is a Discord reply. */
const REPLY_TO = `(SELECT CASE WHEN json_extract(j, '$.type') = ${REPLY_MESSAGE_TYPE} THEN json_extract(j, '$.message_reference.message_id') END
  FROM (SELECT msg_json(m.raw_json) AS j))`;
const INPUT_SQL = `SELECT m.id, m.author_id AS authorId, m.ts, m.content, ${REPLY_TO} AS replyTo FROM messages m`;

interface InputRow { id: string; authorId: string; ts: number; content: string; replyTo: string | null }
const toInput = (r: InputRow): LinkInput => ({
  id: r.id, authorId: r.authorId, ts: r.ts, replyTo: r.replyTo,
  mentions: [...new Set([...r.content.matchAll(USER_MENTION)].map((x) => x[1]!))],
});

/** Messages of a channel after the (ts, id) cursor up to `untilTs`, in time order. */
export function linkInputs(db: Db, channelId: string, after: { ts: number; id: string }, untilTs: number, limit: number): LinkInput[] {
  return (db.prepare(`${INPUT_SQL} WHERE m.channel_id = ? AND m.ts >= ? AND (m.ts, m.id) > (?, ?) AND m.ts <= ? ORDER BY m.ts, m.id LIMIT ?`)
    .all(channelId, after.ts, after.ts, after.id, untilTs, limit) as InputRow[]).map(toInput);
}

/** The channel's messages within `gapMs` before (ts, id), at most `limit` of the newest, in time order. */
export function contextInputs(db: Db, channelId: string, at: { ts: number; id: string }, gapMs: number, limit: number): LinkInput[] {
  return (db.prepare(`${INPUT_SQL} WHERE m.channel_id = ? AND m.ts >= ? AND (m.ts, m.id) < (?, ?) ORDER BY m.ts DESC, m.id DESC LIMIT ?`)
    .all(channelId, at.ts - gapMs, at.ts, at.id, limit) as InputRow[]).map(toInput).reverse();
}

/** A thread started from a message: its first message and the starter (a thread shares its starter's id). */
export function threadStart(db: Db, channelId: string): { firstId: string; starterId: string } | undefined {
  const starter = db.prepare(`SELECT s.id FROM channels c JOIN messages s ON s.id = c.id AND s.channel_id = c.parent_id WHERE c.id = ?`)
    .pluck().get(channelId) as string | undefined;
  if (!starter) return undefined;
  const firstId = db.prepare('SELECT id FROM messages WHERE channel_id = ? ORDER BY ts, id LIMIT 1').pluck().get(channelId) as string | undefined;
  return firstId ? { firstId, starterId: starter } : undefined;
}

/** Delays of the channel's newest linked replies to earlier messages of the same channel. */
function replyDelays(db: Db, channelId: string | null): number[] {
  return db.prepare(`SELECT l.ts - p.ts FROM conversation_links l JOIN messages p ON p.id = l.parent_id
    WHERE l.kind = '${LINK_KIND.reply}' AND p.channel_id = l.channel_id AND l.ts >= p.ts ${channelId ? 'AND l.channel_id = ?' : ''}
    ORDER BY l.ts DESC LIMIT ?`).pluck().all(...(channelId ? [channelId] : []), PACE_SAMPLE) as number[];
}

const percentile = (values: readonly number[], share: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]!;
};

/** How long the channel's conversations wait for an answer, from its own reply delays (plus `extra`, not yet stored). */
export function channelGap(db: Db, channelId: string, extra: readonly number[] = []): number {
  const own = [...extra, ...replyDelays(db, channelId)];
  if (own.length >= PACE_MIN_REPLIES) return percentile(own, PACE_PERCENTILE);
  const all = replyDelays(db, null);
  return all.length >= PACE_MIN_REPLIES ? percentile(all, PACE_PERCENTILE) : PACE_FALLBACK_MS;
}

/** Marks a channel's messages from `fromTs` to `untilTs` for (re)linking; later messages within its gap follow. */
export function queueConversationLinks(db: Db, channelId: string, fromTs: number, untilTs = fromTs): void {
  db.prepare(`INSERT INTO conversation_link_queue (channel_id, from_ts, until_ts) VALUES (?, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET from_ts = min(from_ts, excluded.from_ts), until_ts = max(until_ts, excluded.until_ts)`)
    .run(channelId, fromTs, untilTs);
}

/** A stored message changed (an edit's mentions): it and later messages within its gap are relinked. */
export function queueMessageRelink(db: Db, messageId: string): void {
  const m = db.prepare('SELECT channel_id AS channelId, ts FROM messages WHERE id = ?').get(messageId) as { channelId: string; ts: number } | undefined;
  if (m) queueConversationLinks(db, m.channelId, m.ts);
}

/** Every channel with messages, over all its messages (a new linker version relinks everything). */
export function queueAllConversationLinks(db: Db): void {
  db.exec(`INSERT INTO conversation_link_queue (channel_id, from_ts, until_ts) SELECT channel_id, MIN(ts), MAX(ts) FROM messages GROUP BY channel_id
    ON CONFLICT(channel_id) DO UPDATE SET from_ts = min(from_ts, excluded.from_ts), until_ts = max(until_ts, excluded.until_ts)`);
}

export function writeLinks(db: Db, channelId: string, links: readonly Link[], ts: ReadonlyMap<string, number>): void {
  const put = db.prepare('INSERT OR REPLACE INTO conversation_links (message_id, channel_id, ts, parent_id, kind) VALUES (?, ?, ?, ?, ?)');
  for (const l of links) put.run(l.messageId, channelId, ts.get(l.messageId)!, l.parentId, l.kind);
}
