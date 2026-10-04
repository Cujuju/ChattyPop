// A channel's last-read mark: the newest message the owner saw in the Archive (channels.viewed_id; its ts in viewed_at).
// Marks set before the id was kept hold a time only. What the owner hasn't seen, and moving the mark.
import type { UnreadMark } from '@shared/contract';
import type { Db } from '../db';
import { visibleMessageSql } from './privacy';

/**
 * Message `m` comes after channel `c`'s mark in messagePage's order (ts, then snowflake: shorter is smaller); with no
 * mark, after `@unseen`. A message that arrives late (a sync) older than the mark counts as read, as on Discord.
 */
const afterMarkSql = (m: string, c: string): string => `CASE WHEN ${c}.viewed_id IS NULL THEN ${m}.ts > COALESCE(${c}.viewed_at, @unseen)
  ELSE (${m}.ts, length(${m}.id), ${m}.id) > (${c}.viewed_at, length(${c}.viewed_id), ${c}.viewed_id) END`;

/**
 * Message `m` of channel `c` is unread: visible, after the channel's mark, and not the owner's own (`@self`; '' while
 * the account is unknown, when every message counts). Every unread count (banner, sidebar, notable) uses it.
 */
export const unreadSql = (m: string, c: string): string => `${visibleMessageSql(m)} AND ${afterMarkSql(m, c)} AND ${m}.author_id IS NOT @self`;

const UNREAD_FROM = `FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.channel_id = @channelId AND ${unreadSql('m', 'c')}`;

/**
 * What is unread in a channel for the owner `selfId`; null when nothing is. `unseenSince`: the fallback mark, the end of
 * the previous app session.
 */
export function unreadMark(db: Db, channelId: string, unseenSince: number, selfId: string | null): UnreadMark | null {
  const params = { channelId, unseen: unseenSince, self: selfId ?? '' };
  const first = db.prepare(`SELECT m.id, m.ts ${UNREAD_FROM} ORDER BY m.ts, length(m.id), m.id LIMIT 1`).get(params) as { id: string; ts: number } | undefined;
  if (!first) return null;
  const { count } = db.prepare(`SELECT COUNT(*) AS count ${UNREAD_FROM}`).get(params) as { count: number };
  return { channelId, count, firstId: first.id, firstTs: first.ts };
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
