// Archive message pages with attachments, host judgments and plugin labels.
import { pollFrom, type RawPoll } from '@shared/polls';
import type { ArchiveAttachment, ArchiveEmbed, ArchiveMessage, AttachmentNote, MessageLabel, MessagePageQuery } from '@shared/contract';
import { questionLabels } from '../jev/messageQuestions';
import type { MessageAnnotation } from '@shared/plugins';
import type { Db } from '../db';
import { messageLabels } from '../messageLabels';
import { partNotes } from '../attachmentNotes';
import { embedPartKeys, partKey } from '../messageParts';
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
}

/** Every column an ArchiveMessage is built from; callers add the WHERE clause. */
const SELECT_MESSAGE = `SELECT m.id, m.channel_id AS channelId, m.ts, m.edited_ts AS editedTs, m.deleted_at AS deletedAt, m.pruned_at AS prunedAt, m.content, m.author_id AS authorId,
                         u.username, ${displayNameSql('m.author_id', 'm.channel_id')} AS displayName, u.avatar,
                         ${authorStyleSql('m.author_id', 'm.channel_id')}, ${rawJsonSql('$.author.bot')} AS bot, ${rawJsonSql('$.author.public_flags')} AS publicFlags,
                         CASE WHEN ${rawJsonSql('$.type')} = ${REPLY_MESSAGE_TYPE} THEN ${rawJsonSql('$.message_reference.message_id')} END AS replyToId,
                         ${rawJsonSql('$.reactions')} AS reactionsJson, ${rawJsonSql('$.embeds')} AS embedsJson,
                         ${rawJsonSql('$.sticker_items')} AS stickersJson, ${rawJsonSql('$.referenced_message')} AS refJson,
                         ${rawJsonSql('$.mentions')} AS mentionsJson, ${rawJsonSql('$.mention_everyone')} AS mentionEveryone, ${rawJsonSql('$.flags')} AS flags, ${rawJsonSql('$.application_id')} AS applicationId,
                         ${rawJsonSql('$.components')} AS componentsJson, ${rawJsonSql('$.interaction_metadata')} AS interactionJson,
                         ${rawJsonSql('$.interaction')} AS legacyInteractionJson, ${rawJsonSql('$.poll')} AS pollJson
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
  if (!ids.length) return [];
  return hydrate(db, db.prepare(`${SELECT_MESSAGE} WHERE m.id IN (${ids.map(() => '?').join(',')}) AND ${visibleMessageSql('m')}`).all(...ids) as Row[]);
}

/** Returns chronological message pages with revisions/attachments. before/after bound ids; around centers citation jumps; default selects newest messages. */
export function messagePage(db: Db, q: MessagePageQuery): ArchiveMessage[] {
  const select = `${SELECT_MESSAGE} WHERE m.channel_id = ? AND ${visibleMessageSql('m')}`;
  const newestFirst = 'ORDER BY m.ts DESC, length(m.id) DESC, m.id DESC';
  const oldestFirst = 'ORDER BY m.ts ASC, length(m.id) ASC, m.id ASC';
  // Before / after an anchor in that order (ts, then id as a number: shorter is smaller, then digits).
  const olderThan = '(m.ts < ? OR (m.ts = ? AND (length(m.id) < length(?) OR (length(m.id) = length(?) AND m.id < ?))))';
  const newerThan = '(m.ts > ? OR (m.ts = ? AND (length(m.id) > length(?) OR (length(m.id) = length(?) AND m.id > ?))))';
  let rows: Row[];
  if (q.around) {
    const anchor = db.prepare('SELECT ts FROM messages WHERE id = ?').get(q.around) as { ts: number } | undefined;
    if (!anchor) return messagePage(db, { channelId: q.channelId, limit: q.limit });
    const half = Math.ceil(q.limit / 2);
    // The anchor and older in one half, newer in the other: the same order as before/after, so ties keep the anchor.
    const at = [anchor.ts, anchor.ts, q.around, q.around, q.around];
    const older = db.prepare(`${select} AND NOT ${newerThan} ${newestFirst} LIMIT ?`).all(q.channelId, ...at, half) as Row[];
    const newer = db.prepare(`${select} AND ${newerThan} ${oldestFirst} LIMIT ?`).all(q.channelId, ...at, q.limit - half) as Row[];
    rows = [...older.reverse(), ...newer];
  } else if (q.before) {
    const anchor = db.prepare('SELECT ts FROM messages WHERE id = ?').get(q.before) as { ts: number } | undefined;
    if (!anchor) return [];
    rows = (
      db
        .prepare(`${select} AND ${olderThan} ${newestFirst} LIMIT ?`)
        .all(q.channelId, anchor.ts, anchor.ts, q.before, q.before, q.before, q.limit) as Row[]
    ).reverse();
  } else if (q.after) {
    const anchor = db.prepare('SELECT ts FROM messages WHERE id = ?').get(q.after) as { ts: number } | undefined;
    if (!anchor) return [];
    rows = db
      .prepare(`${select} AND ${newerThan} ${oldestFirst} LIMIT ?`)
      .all(q.channelId, anchor.ts, anchor.ts, q.after, q.after, q.after, q.limit) as Row[];
  } else {
    rows = (db.prepare(`${select} ${newestFirst} LIMIT ?`).all(q.channelId, q.limit) as Row[]).reverse();
  }
  return hydrate(db, rows);
}

/** The notes on the message's own link texts (partKey.linkText): no attachment or card draws them. */
const linkTextNotes = (notes: Map<string, AttachmentNote[]> | undefined): AttachmentNote[] =>
  [...(notes ?? [])].flatMap(([part, list]) => (part.startsWith(partKey.linkText('')) ? list : []));

/** Each embed with the notes of its parts; a part drawn on two embeds (one file) has its notes on the first. */
function withEmbedNotes(embeds: ArchiveEmbed[], notes: Map<string, AttachmentNote[]> | undefined): ArchiveEmbed[] {
  if (!notes) return embeds;
  const drawn = new Set<string>();
  return embeds.map((e, i) => {
    const keys = embedPartKeys(e, i).filter((k) => !drawn.has(k));
    for (const k of keys) drawn.add(k);
    return { ...e, notes: keys.flatMap((k) => notes.get(k) ?? []) };
  });
}

function hydrate(db: Db, rows: Row[]): ArchiveMessage[] {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => '?').join(',');
  const revisions = db
    .prepare(`SELECT message_id AS messageId, content, edited_ts AS editedTs, seen_at AS seenAt FROM message_revisions WHERE message_id IN (${marks}) ORDER BY seen_at`)
    .all(...ids) as { messageId: string; content: string; editedTs: number | null; seenAt: number }[];
  const attachments = db
    .prepare(
      `SELECT id, message_id AS messageId, filename, content_type AS contentType, size, width, height, sha256, status,
       description, flags, removed_at IS NOT NULL AS removed
       FROM attachments WHERE message_id IN (${marks}) ORDER BY rowid`,
    )
    .all(...ids) as (Omit<ArchiveAttachment, 'notes' | 'removed' | 'spoiler'> & { messageId: string; removed: 0 | 1; flags: number | null })[];
  const notes = partNotes(ids.map((id) => ({ id, attachmentIds: attachments.filter((a) => a.messageId === id).map((a) => a.id) })));
  const annotations = db
    .prepare(`SELECT message_id AS messageId, plugin_id AS pluginId, label, text FROM plugin_annotations WHERE message_id IN (${marks}) ORDER BY created_at`)
    .all(...ids) as (MessageAnnotation & { messageId: string })[];
  // Chips: each stored Jev answer whose registered question gives it a label.
  const labelFor = questionLabels();
  const labels = new Map<string, MessageLabel[]>();
  if (labelFor.size) {
    const stored = db
      .prepare(`SELECT message_id AS messageId, subject, value, label FROM jev_judgments WHERE message_id IN (${marks})`)
      .all(...ids) as { messageId: string; subject: string; value: number; label: string | null }[];
    for (const s of stored) {
      const asked = labelFor.get(s.subject);
      const text = asked?.label({ value: s.value, label: s.label });
      if (!asked || !text) continue;
      // A plugin's chip names its plugin, so windows hide it while that plugin is off (presentedParts).
      const owner = asked.pluginId === null ? {} : { pluginId: asked.pluginId };
      labels.set(s.messageId, [...(labels.get(s.messageId) ?? []), { subject: s.subject, text, title: "Jev's label for this message (a model's estimate)", ...owner }]);
    }
  }
  for (const [messageId, own] of messageLabels(ids)) {
    labels.set(messageId, [...(labels.get(messageId) ?? []), ...own]);
  }
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
  return rows.map((r) => {
    const components = componentsFrom(parseJson(r.componentsJson));
    return {
      id: r.id,
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
      embeds: withEmbedNotes(embedsFrom(r.embedsJson), notes.get(r.id)),
      stickers: stickersFrom(r.stickersJson),
      revisions: revisions.filter((v) => v.messageId === r.id).map(({ content, editedTs, seenAt }) => ({ content, editedTs, seenAt })),
      attachments: attachments
        .filter((a) => a.messageId === r.id)
        .map(({ messageId: _m, flags, ...a }) => ({
          ...a,
          spoiler: isSpoiler({ filename: a.filename, flags }),
          animated: isAnimatedImage({ ...a, flags }),
          removed: a.removed === 1,
          notes: notes.get(r.id)?.get(partKey.attachment(a.id)) ?? [],
        })),
      notes: linkTextNotes(notes.get(r.id)),
      annotations: annotations.filter((a) => a.messageId === r.id).map(({ messageId: _m, ...a }) => a),
      labels: labels.get(r.id) ?? [],
      flags: r.flags ?? 0,
      // A bot's own message (not an answer to an interaction) is sent by its app, whose id is the bot's.
      applicationId: r.applicationId ?? (components.length ? r.authorId : null),
      components,
      interaction: interactionFrom(r.interactionJson, r.legacyInteractionJson),
      poll: pollFrom(parseJson(r.pollJson) as RawPoll | null),
    };
  });
}
