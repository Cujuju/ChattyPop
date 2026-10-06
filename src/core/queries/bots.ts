import type { ArchivedBot } from '@shared/contract';
import type { Db } from '../db';
import { ownPrivateChannelSql } from './dmDirectory';
import { visibleMessageSql } from './privacy';

/** Stored history qualifies even after sync was stopped; hidden messages and another account's DMs do not. */
export function archivedBots(db: Db, selfId: string | null): ArchivedBot[] {
  return db.prepare(`SELECT u.id, COALESCE(u.global_name, u.username) AS name, u.username
    FROM users u WHERE u.bot = 1 AND u.id IN (
      SELECT m.author_id FROM messages m JOIN channels c ON c.id = m.channel_id
      WHERE ${ownPrivateChannelSql('c')} AND ${visibleMessageSql('m')}
    ) ORDER BY name COLLATE NOCASE, u.id`).all({ self: selfId ?? '' }) as ArchivedBot[];
}
