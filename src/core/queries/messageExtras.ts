import type { ArchiveReply } from '@shared/contract';
import type { Db } from '../db';
import { displayNameSql, roleColorSql } from './names';
export * from '@shared/messageExtras';

/**
 * Reply lines for a page: the archive's copy of each replied-to message when we have it (current name and text),
 * else the snapshot Discord embedded in the reply.
 */
export function repliesFor(db: Db, refs: { replyToId: string; refJson: string | null }[]): Map<string, ArchiveReply> {
  const out = new Map<string, ArchiveReply>();
  if (!refs.length) return out;
  const ids = [...new Set(refs.map((r) => r.replyToId))];
  const rows = db
    .prepare(
      `SELECT m.id, m.author_id AS authorId, m.content, u.avatar, ${displayNameSql('m.author_id', 'm.channel_id')} AS authorName,
              ${roleColorSql('m.author_id', 'm.channel_id')} AS authorColor
       FROM messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.id IN (${ids.map(() => '?').join(',')})`,
    )
    .all(...ids) as { id: string; authorId: string; content: string; avatar: string | null; authorName: string; authorColor: number | null }[];
  for (const r of rows) out.set(r.id, { messageId: r.id, authorId: r.authorId, authorName: r.authorName, authorColor: r.authorColor, avatar: r.avatar, content: r.content, mentions: {} });
  for (const ref of refs) {
    if (out.has(ref.replyToId) || !ref.refJson) continue;
    try {
      const m = JSON.parse(ref.refJson) as { id: string; content?: string; author?: { id: string; username: string; global_name?: string | null; avatar?: string | null } };
      if (m.author) {
        out.set(ref.replyToId, {
          messageId: m.id,
          authorId: m.author.id,
          authorName: m.author.global_name ?? m.author.username,
          authorColor: null,
          avatar: m.author.avatar ?? null,
          content: m.content ?? '',
          mentions: {},
        });
      }
    } catch {
      // malformed snapshot: no reply line
    }
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
