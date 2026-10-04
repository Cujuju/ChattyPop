// What a stored message carries (ContentKind) and the values rule actions take from it (MessageValues).
import * as linkify from 'linkifyjs';
import { DM_GUILD_ID, VOICE_MESSAGE_FLAG } from '@shared/discord';
import { CONTENT_KINDS, type ContentKind, type MessageValues } from '@shared/messageContent';
import type { Db } from '../db';
import { displayNameSql } from './names';

const attachment = (typeLike: string | null): string =>
  `EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id${typeLike ? ` AND a.content_type LIKE '${typeLike}'` : ''})`;
/** SQL reading JSON `path` (a constant, never user text) from a message's payload; `alias` '' for an unaliased table. */
export const rawJsonSql = (path: string, alias = 'm'): string => `json_extract(msg_json(${alias ? `${alias}.` : ''}raw_json), '${path}')`;

/**
 * SQL per kind for message alias `m`, true when the message carries it. Attachments and links are the derived tables
 * (so derive a message before checking it); the rest reads the raw payload, which retention may have dropped.
 */
export const CONTENT_SQL: Readonly<Record<ContentKind, string>> = {
  voice: `(COALESCE(${rawJsonSql('$.flags')}, 0) & ${VOICE_MESSAGE_FLAG}) != 0`,
  audio: attachment('audio/%'),
  image: attachment('image/%'),
  video: attachment('video/%'),
  file: attachment(null),
  mediaLink: `EXISTS (SELECT 1 FROM message_links ml JOIN links l ON l.id = ml.link_id WHERE ml.message_id = m.id AND l.platform != 'other')`,
  link: 'EXISTS (SELECT 1 FROM message_links ml WHERE ml.message_id = m.id)',
  sticker: `COALESCE(json_array_length(msg_json(m.raw_json), '$.sticker_items'), 0) > 0`,
  poll: `json_type(msg_json(m.raw_json), '$.poll') = 'object'`,
  forward: `COALESCE(json_array_length(msg_json(m.raw_json), '$.message_snapshots'), 0) > 0`,
};

/** Indexed lookups first: OR stops at the first true term, so the payload is decompressed only when needed. */
const CHEAP_FIRST: readonly ContentKind[] = ['file', 'audio', 'image', 'video', 'link', 'mediaLink', 'voice', 'sticker', 'poll', 'forward'];

/** SQL true when message `m` carries any of `kinds` (non-empty). */
export const containsAnySql = (kinds: readonly ContentKind[]): string => `(${CHEAP_FIRST.filter((k) => kinds.includes(k)).map((k) => CONTENT_SQL[k]).join(' OR ')})`;

/** Column list `k_<kind>` (0/1) for message `m`, for reading which kinds a matched row has. */
export const contentColumnsSql = (kinds: readonly ContentKind[]): string => kinds.map((k) => `${CONTENT_SQL[k]} AS k_${k}`).join(', ');
export const kindsOfRow = (row: Record<string, unknown>, kinds: readonly ContentKind[]): Set<ContentKind> => new Set(kinds.filter((k) => row[`k_${k}`] === 1));

/** Reads every kind a message carries (empty when it isn't stored); prepared once, as ingest calls it per message. */
export function contentReader(db: Db): (messageId: string) => Set<ContentKind> {
  const stmt = db.prepare(`SELECT ${contentColumnsSql(CONTENT_KINDS)} FROM messages m WHERE m.id = ?`);
  return (messageId) => {
    const row = stmt.get(messageId) as Record<string, unknown> | undefined;
    return row ? kindsOfRow(row, CONTENT_KINDS) : new Set();
  };
}

/** Seconds of audio in a message's attachments, as Discord reports for voice messages; null when it reports none. */
export function audioSeconds(db: Db, messageId: string): number | null {
  return db
    .prepare(`SELECT SUM(json_extract(a.value, '$.duration_secs')) FROM messages m, json_each(msg_json(m.raw_json), '$.attachments') a WHERE m.id = ?`)
    .pluck()
    .get(messageId) as number | null;
}

/** A stored message's values; null when it isn't stored. */
export function messageValues(db: Db, messageId: string): MessageValues | null {
  const row = db
    .prepare(
      `SELECT m.content, m.author_id AS authorId, m.channel_id AS channelId, c.guild_id AS guildId, ${displayNameSql('m.author_id', 'm.channel_id')} AS author,
              COALESCE(u.username, m.author_id) AS username
       FROM messages m LEFT JOIN channels c ON c.id = m.channel_id LEFT JOIN users u ON u.id = m.author_id WHERE m.id = ?`,
    )
    .get(messageId) as { content: string; authorId: string; channelId: string; guildId: string | null; author: string; username: string } | undefined;
  if (!row) return null;
  const derived = db.prepare("SELECT text FROM derived_texts WHERE message_id = ? AND text != '' ORDER BY ord").pluck().all(messageId) as string[];
  return {
    text: row.content,
    transcript: derived.join('\n'),
    author: row.author,
    username: row.username,
    mention: `<@${row.authorId}>`,
    channel: `<#${row.channelId}>`,
    jump: `https://discord.com/channels/${row.guildId ?? DM_GUILD_ID}/${row.channelId}/${messageId}`,
    links: [...new Set(linkify.find(row.content, 'url').map((l) => l.href))].join('\n'),
  };
}
