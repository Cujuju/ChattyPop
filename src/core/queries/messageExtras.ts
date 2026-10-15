import type { ArchiveReply } from '@shared/contract';
import type { Db } from '../db';
import { displayNameSql, roleColorSql } from './names';
import { VISIBLE_REPLY_SOURCE_SQL } from './privacy';
export * from '@shared/messageExtras';

/** Discord's copy of the replied-to message, as embedded in a reply. */
interface ReplySnapshot {
  id: string;
  channel_id?: string;
  content?: string;
  author?: { id: string; username: string; global_name?: string | null; avatar?: string | null };
}

const parseSnapshot = (json: string | null): ReplySnapshot | null => {
  if (!json) return null;
  try {
    return JSON.parse(json) as ReplySnapshot;
  } catch {
    return null; // malformed snapshot: no reply line
  }
};

/**
 * Reply lines for a page: the archive's copy of each replied-to message when we have it (current name and text),
 * else the snapshot Discord embedded in the reply. Sources privacy mode hides get no line (VISIBLE_REPLY_SOURCE_SQL).
 */
export function repliesFor(db: Db, refs: { replyToId: string; refJson: string | null }[]): Map<string, ArchiveReply> {
  const out = new Map<string, ArchiveReply>();
  if (!refs.length) return out;
  const visible = db.prepare(`SELECT ${VISIBLE_REPLY_SOURCE_SQL}`).pluck();
  const snapshots = new Map<string, ReplySnapshot | null>();
  for (const r of refs) if (!snapshots.get(r.replyToId)) snapshots.set(r.replyToId, parseSnapshot(r.refJson));
  const ids = [...snapshots].flatMap(([id, s]) => (visible.get({ id, channel: s?.channel_id ?? '', text: s?.content ?? '' }) === 1 ? [id] : []));
  if (!ids.length) return out;
  const rows = db
    .prepare(
      `SELECT m.id, m.author_id AS authorId, m.content, u.avatar, ${displayNameSql('m.author_id', 'm.channel_id')} AS authorName,
              ${roleColorSql('m.author_id', 'm.channel_id')} AS authorColor
       FROM messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.id IN (${ids.map(() => '?').join(',')})`,
    )
    .all(...ids) as { id: string; authorId: string; content: string; avatar: string | null; authorName: string; authorColor: number | null }[];
  for (const r of rows) out.set(r.id, { messageId: r.id, authorId: r.authorId, authorName: r.authorName, authorColor: r.authorColor, avatar: r.avatar, content: r.content, mentions: {} });
  for (const id of ids) {
    const m = snapshots.get(id);
    if (out.has(id) || !m?.author) continue;
    out.set(id, {
      messageId: m.id,
      authorId: m.author.id,
      authorName: m.author.global_name ?? m.author.username,
      authorColor: null,
      avatar: m.author.avatar ?? null,
      content: m.content ?? '',
      mentions: {},
    });
  }
  return out;
}

export const USER_MENTION = /<@!?(\d{15,21})>/g;

/** Resolves mentioned names using archive users before payload-known names. Channel context prefers server nicknames; null context uses display names. */
export function mentionNames(db: Db, texts: string[], known: Record<string, string>, channelId: string | null): Record<string, string> {
  const names = { ...known };
  const ids = [...new Set(texts.flatMap((t) => [...t.matchAll(USER_MENTION)].map((m) => m[1]!)))];
  if (ids.length) {
    const name = channelId === null ? 'COALESCE(u.global_name, u.username)' : displayNameSql('u.id', '?');
    const rows = db
      .prepare(`SELECT u.id, ${name} AS name FROM users u WHERE u.id IN (${ids.map(() => '?').join(',')})`)
      .all(...(channelId === null ? [] : [channelId]), ...ids) as { id: string; name: string }[];
    for (const r of rows) names[r.id] = r.name;
  }
  return names;
}
