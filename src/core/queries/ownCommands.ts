// The owner's most-used slash commands, counted from apps' archived replies to them: the `/` menu's "Frequently used".
import { INTERACTION, type UsedCommand } from '@shared/commands';
import type { Db } from '../db';
import { visibleMessageSql } from './privacy';

/** Newest archived messages read (everyone's, since the app posts the reply): weeks of a busy server, at a bounded cost. */
const SCANNED_MESSAGES_MAX = 20000;

/** `userId`'s slash commands in apps' replies, most used first (ties: most recent first), at most `limit`. */
export function ownCommands(db: Db, userId: string, limit: number): UsedCommand[] {
  // interaction_metadata is current; older replies carry only `interaction`.
  const field = (path: string): string => `COALESCE(json_extract(j, '$.interaction_metadata${path}'), json_extract(j, '$.interaction${path}'))`;
  return db
    .prepare(
      `SELECT applicationId, name FROM (
         SELECT COALESCE(json_extract(j, '$.application_id'), author_id) AS applicationId, ${field('.name')} AS name,
                ${field('.user.id')} AS userId, ${field('.type')} AS type, ts
         FROM (SELECT m.author_id, m.ts, msg_json(m.raw_json) AS j FROM messages m
               WHERE m.raw_json IS NOT NULL AND ${visibleMessageSql('m')} ORDER BY m.ts DESC LIMIT @scanned))
       WHERE userId = @userId AND type = @type AND name IS NOT NULL
       GROUP BY applicationId, name ORDER BY COUNT(*) DESC, MAX(ts) DESC LIMIT @limit`,
    )
    .all({ scanned: SCANNED_MESSAGES_MAX, userId, type: INTERACTION.command, limit }) as UsedCommand[];
}
