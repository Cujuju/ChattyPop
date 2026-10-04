// A channel's last-read mark (channels.viewed_at): what the owner hasn't seen in the Archive, and moving the mark.
import type { UnreadMark } from '@shared/contract';
import type { Db } from '../db';
import { visibleMessageSql } from './privacy';

/**
 * Message `m` is unread: newer than its channel's mark (`viewedAt`), else than `@unseen` (never opened), and not the
 * owner's own (`@self`; '' while the account is unknown, when every message counts). Every unread count uses it.
 */
export const unreadSql = (m: string, viewedAt: string): string => `${m}.ts > COALESCE(${viewedAt}, @unseen) AND ${m}.author_id IS NOT @self`;

/** Visible unread messages of `@channelId`: the directory's newCount rule. */
const UNREAD_SQL = `m.channel_id = @channelId AND ${visibleMessageSql('m')} AND ${unreadSql('m', '(SELECT viewed_at FROM channels WHERE id = @channelId)')}`;

/**
 * What is unread in a channel for the owner `selfId`; null when nothing is. `unseenSince`: the fallback mark, the end of
 * the previous app session.
 */
export function unreadMark(db: Db, channelId: string, unseenSince: number, selfId: string | null): UnreadMark | null {
  const params = { channelId, unseen: unseenSince, self: selfId ?? '' };
  // The message order messagePage uses: ts, then snowflake.
  const first = db.prepare(`SELECT m.id, m.ts FROM messages m WHERE ${UNREAD_SQL} ORDER BY m.ts, length(m.id), m.id LIMIT 1`).get(params) as
    | { id: string; ts: number }
    | undefined;
  if (!first) return null;
  const { count } = db.prepare(`SELECT COUNT(*) AS count FROM messages m WHERE ${UNREAD_SQL}`).get(params) as { count: number };
  return { channelId, count, firstId: first.id, firstTs: first.ts };
}

/** Moves the channel's mark to `at` and returns what was unread before it moved, in one transaction. */
export function markViewed(db: Db, channelId: string, at: number, unseenSince: number, selfId: string | null): UnreadMark | null {
  return db.transaction(() => {
    const unread = unreadMark(db, channelId, unseenSince, selfId);
    db.prepare('UPDATE channels SET viewed_at = ? WHERE id = ?').run(at, channelId);
    return unread;
  })();
}

/** The channel's newest message, in messagePage's order: what a read up to now acknowledges. */
export function newestMessageId(db: Db, channelId: string): string | null {
  const row = db.prepare('SELECT id FROM messages WHERE channel_id = ? ORDER BY ts DESC, length(id) DESC, id DESC LIMIT 1').get(channelId) as { id: string } | undefined;
  return row?.id ?? null;
}
