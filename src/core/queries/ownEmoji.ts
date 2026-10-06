// The owner's most-used emoji, counted from their own archived messages (the emoji picker's "Frequently used" row),
// and their most-used reactions.
import type { ArchiveEmoji } from '@shared/contract';
import { CUSTOM_EMOJI } from '@shared/emoji';
import type { UsedEmoji } from '@shared/compose';
import type { Db } from '../db';
import { visibleMessageSql } from './privacy';

/** Newest own messages read: recent habits, and the scan stays small however long the archive grows. */
const SCANNED_MESSAGES_MAX = 5000;
/** A whole emoji: Unicode's recommended sequences, so skin tones, flags and joined emoji count as one. */
const UNICODE_EMOJI = /\p{RGI_Emoji}/gv;

/** Emoji in `authorId`'s messages, most used first (ties: most recent first), at most `limit`. */
export function ownEmoji(db: Db, authorId: string, limit: number): UsedEmoji[] {
  const contents = db
    .prepare(`SELECT m.content FROM messages m WHERE m.author_id = ? AND ${visibleMessageSql('m')} ORDER BY m.ts DESC LIMIT ?`)
    .pluck()
    .all(authorId, SCANNED_MESSAGES_MAX) as string[];
  // Insertion order is recency (newest message first), which breaks count ties.
  const counts = new Map<string, { emoji: UsedEmoji; uses: number }>();
  const add = (key: string, emoji: UsedEmoji): void => {
    const seen = counts.get(key);
    if (seen) seen.uses++;
    else counts.set(key, { emoji, uses: 1 });
  };
  for (const content of contents) {
    for (const m of content.matchAll(CUSTOM_EMOJI)) add(m[3]!, { custom: { animated: m[1] === 'a', name: m[2]!, id: m[3]! } });
    for (const [text] of content.replace(CUSTOM_EMOJI, ' ').matchAll(UNICODE_EMOJI)) add(text, { unicode: text });
  }
  return [...counts.values()]
    .sort((a, b) => b.uses - a.uses)
    .slice(0, limit)
    .map((c) => c.emoji);
}

/** Newest messages read for the owner's reactions: anyone's, since the owner reacts to others' messages. */
const SCANNED_FOR_REACTIONS_MAX = 20_000;

/** Ranks owner reactions by usage, then recency, limited to limit. Super reactions lack me and do not count. */
export function ownReactions(db: Db, limit: number): ArchiveEmoji[] {
  const rows = db
    .prepare(
      `SELECT json_extract(r.value, '$.emoji.id') AS emojiId, json_extract(r.value, '$.emoji.name') AS emojiName,
              MAX(json_extract(r.value, '$.emoji.animated')) AS animated, COUNT(*) AS uses, MAX(m.ts) AS last
       FROM (SELECT m.ts, m.raw_json FROM messages m WHERE ${visibleMessageSql('m')} ORDER BY m.ts DESC LIMIT ?) m,
            json_each(msg_json(m.raw_json), '$.reactions') r
       WHERE json_extract(r.value, '$.me') = 1 AND emojiName IS NOT NULL
       GROUP BY COALESCE(emojiId, emojiName) ORDER BY uses DESC, last DESC LIMIT ?`,
    )
    .all(SCANNED_FOR_REACTIONS_MAX, limit) as { emojiId: string | null; emojiName: string; animated: number | null }[];
  return rows.map((r) => ({ id: r.emojiId, name: r.emojiName, animated: r.animated === 1 }));
}
