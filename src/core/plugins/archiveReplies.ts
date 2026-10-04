// Narrow reply reads avoid constructing complete archive payload metadata.
import type { Db } from '../db';
import { rawJsonSql } from '../queries/messageContent';
import { REPLY_MESSAGE_TYPE } from '../queries/messageExtras';
import type { PluginDb } from './pluginDb';

export type ArchiveReplyReader = (ids: readonly string[]) => Map<string, { isReply: number | null }>;
export type ArchiveReplyExists = (channelId: string, afterTs: number, authorId: string, messageId: string) => boolean;

/** The message a Discord reply answers, from the copy Discord embeds in the reply (`referenced_message`). */
export interface ReplyTarget {
  id: string;
  authorId: string;
  /** The target author's display name, else username, as the reply embedded it. */
  author: string;
  content: string;
}
/** Reply targets of selected ids; ids that aren't replies, or whose embedded target is unreadable, are left out. */
export type ArchiveReplyTargets = (ids: readonly string[]) => Map<string, ReplyTarget>;

/** Uses the channel/time index and stops on the first reply by another author. */
export function archiveReplyExists(db: Db, channelId: string, afterTs: number, authorId: string, messageId: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM messages WHERE channel_id = ? AND ts > ? AND author_id != ?
    AND json_extract(msg_json(raw_json), '$.message_reference.message_id') = ? LIMIT 1`)
    .get(channelId, afterTs, authorId, messageId));
}

/** Reads only the reply flag for selected ids, using the message primary key. */
export function archiveReplyFlags(db: Db, ids: readonly string[]): ReturnType<ArchiveReplyReader> {
  if (!ids.length) return new Map();
  const rows = db.prepare(`SELECT id, json_extract(msg_json(raw_json), '$.type') = ${REPLY_MESSAGE_TYPE} AS isReply
    FROM messages WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as { id: string; isReply: number | null }[];
  return new Map(rows.map((row) => [row.id, { isReply: row.isReply }]));
}

/** What selected replies answer, read from the target Discord embedded in each (compressed payloads included). */
export function archiveReplyTargets(db: PluginDb, ids: readonly string[]): Map<string, ReplyTarget> {
  if (!ids.length) return new Map();
  const rows = db
    .prepare(
      `SELECT m.id AS replyId, ${rawJsonSql('$.message_reference.message_id')} AS id,
              ${rawJsonSql('$.referenced_message.author.id')} AS authorId,
              COALESCE(${rawJsonSql('$.referenced_message.author.global_name')},
                       ${rawJsonSql('$.referenced_message.author.username')}) AS author,
              COALESCE(${rawJsonSql('$.referenced_message.content')}, '') AS content
       FROM messages m WHERE m.id IN (SELECT value FROM json_each(?)) AND ${rawJsonSql('$.type')} = ${REPLY_MESSAGE_TYPE}`,
    )
    .all(JSON.stringify(ids)) as (ReplyTarget & { replyId: string })[];
  return new Map(rows.filter((r) => r.authorId).map(({ replyId, ...target }) => [replyId, target]));
}
