// Archive message pages with attachments, host judgments and plugin labels.
import { pollFrom, pollResultFrom, type RawPoll } from '@shared/polls';
import type { ArchiveAttachment, ArchiveMessage, MessageWindow, MessagePageQuery } from '@shared/contract';
import type { MessageAnnotation } from '@shared/plugins';
import type { Db } from '../db';
import { decorateMessages, type MessageSnapshot } from './messageDecorations';
import { rawJsonSql } from './messageContent';
import { authorStyleSql, displayNameSql } from './names';
import { roleColors } from './nameStyle';
import { visibleMessageSql } from './privacy';
import { componentsFrom } from '@shared/components';
import { isAnimatedImage, isSpoiler } from '@shared/media';
import { VERIFIED_BOT_FLAG } from '@shared/discord';
import { REPLY_MESSAGE_TYPE, embedsFrom, nameFontFrom, serverTagFrom, interactionFrom, parseJson, mentionIdsFrom, mentionNames, mentionsFrom, reactionsFrom, repliesFor, stickersFrom } from './messageExtras';

/** The author's columns of a row. */
interface AuthorRow {
  authorId: string;
  username: string | null;
  displayName: string;
  avatar: string | null;
  roleColorsJson: string | null;
  enhancedRoles: number;
  nameStyle: string | null;
  decoration: string | null;
  roleIconJson: string | null;
  tagGuildId: string | null;
  tag: string | null;
  tagBadge: string | null;
  bot: number | null;
  publicFlags: number | null;
}

interface Row extends AuthorRow {
  id: string;
  nonce: string | number | null;
  channelId: string;
  ts: number;
  editedTs: number | null;
  deletedAt: number | null;
  prunedAt: number | null;
  content: string;
  replyToId: string | null;
  reactionsJson: string | null;
  embedsJson: string | null;
  stickersJson: string | null;
  refJson: string | null;
  mentionsJson: string | null;
  /** 1 when an @everyone or @here in it pinged (Discord sets it only when the author may). */
  mentionEveryone: number | null;
  flags: number | null;
  applicationId: string | null;
  componentsJson: string | null;
  interactionJson: string | null;
  legacyInteractionJson: string | null;
  pollJson: string | null;
  /** Discord's message type, and the message its reference names (a reply's target, a poll result's poll). */
  type: number | null;
  refMessageId: string | null;
}

/** Every column an ArchiveMessage is built from; callers add the WHERE clause. */
const SELECT_MESSAGE = `SELECT ${rawJsonSql('$.nonce')} AS nonce, m.id, m.channel_id AS channelId, m.ts, m.edited_ts AS editedTs, m.deleted_at AS deletedAt, m.pruned_at AS prunedAt, m.content, m.author_id AS authorId,
                         u.username, ${displayNameSql('m.author_id', 'm.channel_id')} AS displayName, u.avatar,
                         ${authorStyleSql('m.author_id', 'm.channel_id')}, ${rawJsonSql('$.author.bot')} AS bot, ${rawJsonSql('$.author.public_flags')} AS publicFlags,
                         CASE WHEN ${rawJsonSql('$.type')} = ${REPLY_MESSAGE_TYPE} THEN ${rawJsonSql('$.message_reference.message_id')} END AS replyToId,
                         ${rawJsonSql('$.reactions')} AS reactionsJson, ${rawJsonSql('$.embeds')} AS embedsJson,
                         ${rawJsonSql('$.sticker_items')} AS stickersJson, ${rawJsonSql('$.referenced_message')} AS refJson,
                         ${rawJsonSql('$.mentions')} AS mentionsJson, ${rawJsonSql('$.mention_everyone')} AS mentionEveryone, ${rawJsonSql('$.flags')} AS flags, ${rawJsonSql('$.application_id')} AS applicationId,
                         ${rawJsonSql('$.components')} AS componentsJson, ${rawJsonSql('$.interaction_metadata')} AS interactionJson,
                         ${rawJsonSql('$.interaction')} AS legacyInteractionJson, ${rawJsonSql('$.poll')} AS pollJson,
                         ${rawJsonSql('$.type')} AS type, ${rawJsonSql('$.message_reference.message_id')} AS refMessageId
                  FROM messages m LEFT JOIN users u ON u.id = m.author_id`;

/** A message's author as the Archive draws them in the row's channel: name, avatar and style there. */
const authorFrom = (r: AuthorRow): ArchiveMessage['author'] => ({
  id: r.authorId,
  name: r.displayName,
  username: r.username,
  avatar: r.avatar,
  ...roleColors(r.roleColorsJson, r.enhancedRoles === 1),
  font: nameFontFrom(r.nameStyle),
  decoration: r.decoration,
  roleIcon: parseJson(r.roleIconJson) as ArchiveMessage['author']['roleIcon'],
  tag: serverTagFrom(r.tagGuildId, r.tag, r.tagBadge),
  app: r.bot === 1 ? { verified: ((r.publicFlags ?? 0) & VERIFIED_BOT_FLAG) !== 0 } : null,
});

/** The owner as the author of a message they post in `channelId`, drawn as their archived messages there are; null before the archive knows them. */
export function ownAuthor(db: Db, selfId: string | null, channelId: string): ArchiveMessage['author'] | null {
  if (selfId === null) return null;
  const row = db
    .prepare(
      `SELECT u.id AS authorId, u.username, ${displayNameSql('@self', '@channel')} AS displayName, u.avatar, ${authorStyleSql('@self', '@channel')},
       NULL AS bot, NULL AS publicFlags FROM users u WHERE u.id = @self`,
    )
    .get({ self: selfId, channel: channelId }) as AuthorRow | undefined;
  return row ? authorFrom(row) : null;
}

/** Archived messages by id, as the Archive shows them; ids not in the archive, or hidden by privacy mode, are left out. */
export function messagesByIds(db: Db, ids: string[]): ArchiveMessage[] {
  return decorateMessages(messageSnapshotByIds(db, ids));
}

/** Serializable archive data; live plugin callbacks belong to Core after the helper has replied. */
export function messageSnapshotByIds(db: Db, ids: string[]): MessageSnapshot {
  return snapshot(db, ids.length ? db.prepare(`${SELECT_MESSAGE} WHERE m.id IN (SELECT value FROM json_each(?)) AND ${visibleMessageSql('m')}`).all(JSON.stringify(ids)) as Row[] : []);
}

/** Returns chronological message pages with revisions/attachments. before/after bound ids; around centers citation jumps; default selects newest messages. */
export function messagePage(db: Db, q: MessagePageQuery): ArchiveMessage[] {
  return decorateMessages(messagePageSnapshot(db, q));
}

/** Page selection and hydration share the helper's committed snapshot. */
export function messagePageSnapshot(db: Db, q: MessagePageQuery): MessageSnapshot {
  const select = `${SELECT_MESSAGE} WHERE m.channel_id = ? AND ${visibleMessageSql('m')}`;
  const newestFirst = 'ORDER BY m.ts DESC, length(m.id) DESC, m.id DESC';
  const oldestFirst = 'ORDER BY m.ts ASC, length(m.id) ASC, m.id ASC';
  // Before / after an anchor in that order (ts, then id as a number: shorter is smaller, then digits).
  const olderThan = '(m.ts < ? OR (m.ts = ? AND (length(m.id) < length(?) OR (length(m.id) = length(?) AND m.id < ?))))';
  const newerThan = '(m.ts > ? OR (m.ts = ? AND (length(m.id) > length(?) OR (length(m.id) = length(?) AND m.id > ?))))';
  let rows: Row[];
  if (q.around) {
    const anchor = db.prepare('SELECT ts FROM messages WHERE id = ?').get(q.around) as { ts: number } | undefined;
    if (!anchor) return messagePageSnapshot(db, { channelId: q.channelId, limit: q.limit });
    const half = Math.ceil(q.limit / 2);
    // The anchor and older in one half, newer in the other: the same order as before/after, so ties keep the anchor.
    const at = [anchor.ts, anchor.ts, q.around, q.around, q.around];
    const older = db.prepare(`${select} AND NOT ${newerThan} ${newestFirst} LIMIT ?`).all(q.channelId, ...at, half) as Row[];
    const newer = db.prepare(`${select} AND ${newerThan} ${oldestFirst} LIMIT ?`).all(q.channelId, ...at, q.limit - half) as Row[];
    rows = [...older.reverse(), ...newer];
  } else if (q.before) {
    const anchor = db.prepare('SELECT ts FROM messages WHERE id = ?').get(q.before) as { ts: number } | undefined;
    if (!anchor) return { items: [], judgments: [] };
    rows = (
      db
        .prepare(`${select} AND ${olderThan} ${newestFirst} LIMIT ?`)
        .all(q.channelId, anchor.ts, anchor.ts, q.before, q.before, q.before, q.limit) as Row[]
    ).reverse();
  } else if (q.after) {
    const anchor = db.prepare('SELECT ts FROM messages WHERE id = ?').get(q.after) as { ts: number } | undefined;
    if (!anchor) return { items: [], judgments: [] };
    rows = db
      .prepare(`${select} AND ${newerThan} ${oldestFirst} LIMIT ?`)
      .all(q.channelId, anchor.ts, anchor.ts, q.after, q.after, q.after, q.limit) as Row[];
  } else {
    rows = (db.prepare(`${select} ${newestFirst} LIMIT ?`).all(q.channelId, q.limit) as Row[]).reverse();
  }
  return snapshot(db, rows);
}

/** Returns a restore window and its newest boundary without a second renderer round trip. */
export function messageWindow(db: Db, q: MessagePageQuery): MessageWindow {
  const { snapshot, reachesNewest } = messageWindowSnapshot(db, q);
  return { items: decorateMessages(snapshot), reachesNewest };
}

export function messageWindowSnapshot(db: Db, q: MessagePageQuery): { snapshot: MessageSnapshot; reachesNewest: boolean } {
  const snapshot = messagePageSnapshot(db, q);
  const newest = db.prepare(`SELECT m.id FROM messages m WHERE m.channel_id = ? AND ${visibleMessageSql('m')}
    ORDER BY m.ts DESC, length(m.id) DESC, m.id DESC LIMIT 1`).get(q.channelId) as { id: string } | undefined;
  return { snapshot, reachesNewest: !newest || snapshot.items.some((m) => m.id === newest.id) };
}

function snapshot(db: Db, rows: Row[]): MessageSnapshot {
  if (!rows.length) return { items: [], judgments: [] };
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => '?').join(',');
  const revisions = db
    .prepare(`SELECT message_id AS messageId, content, edited_ts AS editedTs, seen_at AS seenAt FROM message_revisions WHERE message_id IN (${marks}) ORDER BY seen_at`)
    .all(...ids) as { messageId: string; content: string; editedTs: number | null; seenAt: number }[];
  const attachments = db
    .prepare(
      `SELECT id, message_id AS messageId, filename, content_type AS contentType, size, width, height, sha256, status,
       stored_ext AS storedExt, stored_bytes AS storedBytes, compressed_at IS NOT NULL AS compressed,
       description, flags, removed_at IS NOT NULL AS removed
       FROM attachments WHERE message_id IN (${marks}) ORDER BY rowid`,
    )
    .all(...ids) as (Omit<ArchiveAttachment, 'notes' | 'removed' | 'spoiler' | 'compressed'> & { messageId: string; removed: 0 | 1; compressed: 0 | 1; flags: number | null })[];
  const annotations = db
    .prepare(`SELECT message_id AS messageId, plugin_id AS pluginId, label, text FROM plugin_annotations WHERE message_id IN (${marks}) ORDER BY created_at`)
    .all(...ids) as (MessageAnnotation & { messageId: string })[];
  const judgments = db
    .prepare(`SELECT message_id AS messageId, subject, value, label FROM jev_judgments WHERE message_id IN (${marks})`)
    .all(...ids) as MessageSnapshot['judgments'];
  const replies = repliesFor(
    db,
    rows.flatMap((r) => (r.replyToId ? [{ replyToId: r.replyToId, refJson: r.refJson }] : [])),
  );
  // One name map per channel (its server's nicknames) covers every message and reply preview from it.
  const names = new Map<string, Record<string, string>>();
  for (const channelId of new Set(rows.map((r) => r.channelId))) {
    const own = rows.filter((r) => r.channelId === channelId);
    const ownReplies = own.flatMap((r) => (r.replyToId && replies.has(r.replyToId) ? [replies.get(r.replyToId)!] : []));
    const map = mentionNames(
      db,
      [...own.map((r) => r.content), ...ownReplies.map((r) => r.content)],
      Object.assign({}, ...own.map((r) => mentionsFrom(r.mentionsJson))) as Record<string, string>,
      channelId,
    );
    names.set(channelId, map);
    for (const reply of ownReplies) reply.mentions = map;
  }
  const items: ArchiveMessage[] = rows.map((r) => {
    const components = componentsFrom(parseJson(r.componentsJson));
    return {
      id: r.id,
      ...(r.nonce == null ? {} : { nonce: String(r.nonce) }),
      channelId: r.channelId,
      ts: r.ts,
      editedTs: r.editedTs,
      deletedAt: r.deletedAt,
      prunedAt: r.prunedAt,
      content: r.content,
      author: authorFrom(r),
      replyToId: r.replyToId,
      reply: r.replyToId ? (replies.get(r.replyToId) ?? null) : null,
      reactions: reactionsFrom(r.reactionsJson),
      mentions: names.get(r.channelId)!,
      mentionIds: mentionIdsFrom(r.mentionsJson),
      mentionsEveryone: r.mentionEveryone === 1,
      embeds: embedsFrom(r.embedsJson),
      stickers: stickersFrom(r.stickersJson),
      revisions: revisions.filter((v) => v.messageId === r.id).map(({ content, editedTs, seenAt }) => ({ content, editedTs, seenAt })),
      attachments: attachments
        .filter((a) => a.messageId === r.id)
        .map(({ messageId: _m, flags, ...a }) => ({
          ...a,
          spoiler: isSpoiler({ filename: a.filename, flags }),
          animated: isAnimatedImage({ ...a, flags }),
          removed: a.removed === 1,
          compressed: a.compressed === 1,
          notes: [],
        })),
      notes: [],
      annotations: annotations.filter((a) => a.messageId === r.id).map(({ messageId: _m, ...a }) => a),
      labels: [],
      flags: r.flags ?? 0,
      // A bot's own message (not an answer to an interaction) is sent by its app, whose id is the bot's.
      applicationId: r.applicationId ?? (components.length ? r.authorId : null),
      components,
      interaction: interactionFrom(r.interactionJson, r.legacyInteractionJson),
      poll: pollFrom(parseJson(r.pollJson) as RawPoll | null),
      pollResult: pollResultFrom(r.type, parseJson(r.embedsJson), r.refMessageId),
    };
  });
  return { items, judgments };
}
