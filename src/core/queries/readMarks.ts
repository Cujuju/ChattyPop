// What the owner has read in a channel: the newest message they saw in the Archive (channels.viewed_id; its ts in
// viewed_at; marks set before the id was kept hold a time only), and Discord's read state (read_states.ack_id), which
// moves when the owner sends from any client or reads in another. What the owner hasn't seen, and moving the mark.
import type { UnreadBoundary, UnreadMark, UnreadSnapshot } from '@shared/contract';
import { SETTINGS_KEYS, normalizeCountedBots } from '@shared/settings';
import { getSetting, setSetting, type Db } from '../db';
import { visibleMessageSql } from './privacy';

/** The account last signed in: whose messages are their own until this session's READY names it. */
const READER_KEY = 'session.readerId';
/**
 * The account last signed in; before one was recorded, the only account whose DMs are stored. Null when none is known,
 * or DMs of several are (every message then counts until READY).
 */
export const lastReader = (db: Db): string | null => {
  const v = getSetting(db, READER_KEY);
  if (typeof v === 'string') return v;
  const accounts = db.prepare('SELECT DISTINCT account_id FROM channels WHERE account_id IS NOT NULL LIMIT 2').pluck().all() as string[];
  return accounts.length === 1 ? accounts[0]! : null;
};
export const recordReader = (db: Db, userId: string): void => setSetting(db, READER_KEY, userId);

/**
 * Message `m` comes after channel `c`'s mark in messagePage's order (ts, then snowflake: shorter is smaller); with no
 * mark, after `@unseen`. A message that arrives late (a sync) older than the mark counts as read, as on Discord.
 */
const afterMarkSql = (m: string, c: string): string => `CASE WHEN ${c}.viewed_id IS NULL THEN ${m}.ts > COALESCE(${c}.viewed_at, @unseen)
  ELSE (${m}.ts, length(${m}.id), ${m}.id) > (${c}.viewed_at, length(${c}.viewed_id), ${c}.viewed_id) END`;

/** Message `m` comes after Discord's read state `rs` (snowflake order: ts derives from the id); none known, it does. */
const afterAckSql = (m: string, rs: string): string => `(${rs}.ack_id IS NULL OR (length(${m}.id), ${m}.id) > (length(${rs}.ack_id), ${rs}.ack_id))`;

/**
 * Visible, not the owner's own, and human or a bot the owner chose. Bot identity outlives payload retention.
 */
const countedSql = (m: string): string => `${m}.author_id IS NOT @reader
  AND (NOT EXISTS (SELECT 1 FROM users u WHERE u.id = ${m}.author_id AND u.bot = 1)
       OR ${m}.author_id IN (SELECT value FROM json_each(@countedBots))) AND ${visibleMessageSql(m)}`;

/** Bound once per query, so every count shares the normalized selection without decoding message payloads. */
export const unreadParams = (db: Db): { countedBots: string } => ({
  countedBots: JSON.stringify(normalizeCountedBots(getSetting(db, SETTINGS_KEYS.countedBots))),
});

const afterReadMarksSql = (m: string, c: string, rs: string): string =>
  `${m}.ts >= COALESCE(${c}.viewed_at, @unseen) AND ${afterMarkSql(m, c)} AND ${afterAckSql(m, rs)}`;

/**
 * Message `m` of channel `c` (`rs`: its read_states row, LEFT JOINed) is unread: after the Archive's mark and Discord's
 * read state, and counted (countedSql). The leading bound is implied by the mark; it lets the (channel_id, ts) index
 * take the range. Every unread count (banner, sidebar, notable) uses it.
 */
export const unreadSql = (m: string, c: string, rs: string): string =>
  `${afterReadMarksSql(m, c, rs)} AND ${countedSql(m)}`;

/**
 * Whether the owner `readerId` has read message `messageId`: at or before the Archive's mark or Discord's read state, or
 * their own. A channel never opened in the Archive is read only as far as Discord says. False for a message not stored.
 */
export function messageRead(db: Db, messageId: string, readerId: string | null): boolean {
  const row = db
    .prepare(
      `SELECT ${afterMarkSql('m', 'c')} AND ${afterAckSql('m', 'rs')} AND m.author_id IS NOT @reader AS unread
       FROM messages m JOIN channels c ON c.id = m.channel_id LEFT JOIN read_states rs ON rs.channel_id = c.id WHERE m.id = @id`,
    )
    // @unseen 0: with no mark, every message is after it.
    .get({ id: messageId, unseen: 0, reader: readerId ?? '' }) as { unread: number } | undefined;
  return row !== undefined && !row.unread;
}

const UNREAD_FROM = `FROM messages m JOIN channels c ON c.id = m.channel_id LEFT JOIN read_states rs ON rs.channel_id = c.id WHERE m.channel_id = @channelId`;

/**
 * What is unread in a channel for the owner `readerId`; null when nothing is. `unseenSince`: the fallback mark, the end
 * of the previous app session. `sinceId`: count from that message (a banner's first unread) instead of the Archive's
 * mark, still leaving out what Discord's read state covers and what isn't counted (countedSql). `localReadId` lets a
 * banner keep its opening messages after this view's own acknowledgment; later acknowledgments still bound it.
 */
export function unreadMark(db: Db, channelId: string, unseenSince: number, readerId: string | null, since?: string | UnreadBoundary, localReadId?: string): UnreadMark | null {
  const params = {
    channelId, unseen: unseenSince, reader: readerId ?? '', ...unreadParams(db),
    ...(typeof since === 'string' ? { since } : since ? { sinceId: since.id, sinceTs: since.ts } : {}),
    localRead: localReadId ?? '',
    externalAck: typeof since === 'object' ? since.ackId ?? '' : '',
  };
  const bound = typeof since === 'string'
    ? '(SELECT s.ts, length(s.id), s.id FROM messages s WHERE s.id = @since AND s.channel_id = @channelId)'
    : '(@sinceTs, length(@sinceId), @sinceId)';
  const where = since
    ? `${UNREAD_FROM} AND (m.ts, length(m.id), m.id) >= ${bound}
         AND (@externalAck = '' OR (length(m.id), m.id) > (length(@externalAck), @externalAck))
         AND (${afterAckSql('m', 'rs')} OR (@localRead != '' AND (length(rs.ack_id), rs.ack_id) <= (length(@localRead), @localRead)))
         AND ${countedSql('m')}`
    : `${UNREAD_FROM} AND ${unreadSql('m', 'c', 'rs')}`;
  const first = db.prepare(`SELECT m.id, m.ts ${where} ORDER BY m.ts, length(m.id), m.id LIMIT 1`).get(params) as { id: string; ts: number } | undefined;
  if (!first) return null;
  const { count } = db.prepare(`SELECT COUNT(*) AS count ${where}`).get(params) as { count: number };
  return { channelId, count, firstId: first.id, firstTs: first.ts };
}

/** Capture the opening boundary even when all its messages are excluded bots, before the view advances its read mark. */
export function unreadSnapshot(db: Db, channelId: string, unseenSince: number, readerId: string | null): UnreadSnapshot {
  const boundary = db.prepare(`SELECT m.id, m.ts ${UNREAD_FROM} AND ${afterReadMarksSql('m', 'c', 'rs')}
    AND m.author_id IS NOT @reader AND ${visibleMessageSql('m')} ORDER BY m.ts, length(m.id), m.id LIMIT 1`)
    .get({ channelId, unseen: unseenSince, reader: readerId ?? '' }) as UnreadBoundary | undefined;
  return { boundary: boundary ?? null, unread: unreadMark(db, channelId, unseenSince, readerId) };
}

/**
 * Moves the channel's mark up to `messageId`, a visible message of it the owner saw; never back, so answers arriving
 * out of order can't undo a read. Returns whether it moved.
 */
export function markRead(db: Db, channelId: string, messageId: string): boolean {
  return (
    db
      .prepare(
        `UPDATE channels SET viewed_at = (SELECT ts FROM messages WHERE id = @messageId), viewed_id = @messageId
         WHERE id = @channelId AND EXISTS (SELECT 1 FROM messages m WHERE m.id = @messageId AND m.channel_id = @channelId
           AND ${visibleMessageSql('m')} AND (channels.viewed_at IS NULL OR ${afterMarkSql('m', 'channels')}))`,
      )
      // @unseen is unused: a channel never marked moves to any message.
      .run({ channelId, messageId, unseen: 0 }).changes > 0
  );
}

/** The channel's newest message, in messagePage's order: what a read up to now acknowledges. */
export function newestMessageId(db: Db, channelId: string): string | null {
  const row = db.prepare('SELECT id FROM messages WHERE channel_id = ? ORDER BY ts DESC, length(id) DESC, id DESC LIMIT 1').get(channelId) as { id: string } | undefined;
  return row?.id ?? null;
}
