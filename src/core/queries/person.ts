// Person view: one author's footprint in the archive. Plain SQL, no AI; privacy mode applies to every part.
import type { PersonProfile } from '@shared/contract';
import { nameFontFrom, serverTagFrom } from './messageExtras';
import type { Db } from '../db';
import { visibleChannelSql, visibleMessageSql } from './privacy';

/** Channels listed: enough to show where someone lives without a long scroll. */
export const PERSON_TOP_CHANNELS = 8;
/** Links listed, newest first; the Links feed holds the rest. */
export const PERSON_RECENT_LINKS = 10;

/** Null when the archive has never seen this user. */
export function personProfile(db: Db, userId: string): PersonProfile | null {
  const user = db
    .prepare('SELECT id, username, global_name, avatar, name_style, decoration, tag_guild_id, tag, tag_badge FROM users WHERE id = ?')
    .get(userId) as
    | { id: string; username: string; global_name: string | null; avatar: string | null; name_style: string | null; decoration: string | null; tag_guild_id: string | null; tag: string | null; tag_badge: string | null }
    | undefined;
  if (!user) return null;
  // Every per-message part reads only this person's visible messages.
  const theirs = `m.author_id = @user AND ${visibleMessageSql('m')}`;
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS messages, COUNT(m.edited_ts) AS edited, COUNT(m.deleted_at) AS deleted, MIN(m.ts) AS firstTs, MAX(m.ts) AS lastTs,
              (SELECT COUNT(DISTINCT ml.link_id) FROM message_links ml JOIN messages m ON m.id = ml.message_id WHERE ${theirs}) AS links,
              (SELECT COUNT(*) FROM attachments a JOIN messages m ON m.id = a.message_id WHERE ${theirs}) AS attachments
       FROM messages m WHERE ${theirs}`,
    )
    .get({ user: userId }) as PersonProfile['totals'] & { firstTs: number | null; lastTs: number | null };
  return {
    id: user.id,
    username: user.username,
    globalName: user.global_name,
    avatar: user.avatar,
    style: {
      font: nameFontFrom(user.name_style),
      decoration: user.decoration,
      tag: serverTagFrom(user.tag_guild_id, user.tag, user.tag_badge),
    },
    nicknames: db
      .prepare(
        // Any visible channel of the server stands for it: names are read per channel (personNames).
        `SELECT mem.guild_id AS guildId, g.name AS guildName, mem.nick,
                (SELECT MIN(c.id) FROM channels c WHERE c.guild_id = mem.guild_id AND ${visibleChannelSql('c.id')}) AS channelId
         FROM members mem LEFT JOIN guilds g ON g.id = mem.guild_id
         WHERE mem.user_id = @user AND mem.nick IS NOT NULL AND mem.guild_id NOT IN (SELECT id FROM hidden_ids) ORDER BY g.name`,
      )
      .all({ user: userId }) as PersonProfile['nicknames'],
    totals: { messages: totals.messages, edited: totals.edited, deleted: totals.deleted, links: totals.links, attachments: totals.attachments },
    firstTs: totals.firstTs,
    lastTs: totals.lastTs,
    channels: db
      .prepare(
        `SELECT m.channel_id AS channelId, COALESCE(c.name, m.channel_id) AS channelName, g.id AS guildId, g.name AS guildName, g.icon AS guildIcon,
                COUNT(*) AS count, MAX(m.ts) AS lastTs
         FROM messages m LEFT JOIN channels c ON c.id = m.channel_id LEFT JOIN guilds g ON g.id = c.guild_id
         WHERE ${theirs} GROUP BY m.channel_id ORDER BY count DESC, lastTs DESC LIMIT @limit`,
      )
      .all({ user: userId, limit: PERSON_TOP_CHANNELS }) as PersonProfile['channels'],
    links: db
      .prepare(
        // One row per link at their latest share of it (SQLite fills bare columns from the MAX row).
        `SELECT l.url, l.platform, l.title, m.id AS messageId, m.channel_id AS channelId, MAX(m.ts) AS ts
         FROM message_links ml JOIN messages m ON m.id = ml.message_id JOIN links l ON l.id = ml.link_id
         WHERE ${theirs} GROUP BY l.id ORDER BY ts DESC LIMIT @limit`,
      )
      .all({ user: userId, limit: PERSON_RECENT_LINKS }) as PersonProfile['links'],
  };
}
