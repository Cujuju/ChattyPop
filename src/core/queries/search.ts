// Archive search conditions and FTS results, including registered plugin tokens.
import { SEARCH_MATCH_END, SEARCH_MATCH_START, type SearchHit } from '@shared/contract';
import { mentionedUserId, parseSearchQuery, type HasKind, type IsKind, type SearchSort, type SearchTerm } from '@shared/searchQuery';
import type { Db } from '../db';
import { searchTokenKeys, searchTokenCondition } from '../searchTokens';
import { THREAD_KINDS_SQL } from './channelScope';
import { snippet } from './snippet';
import { CONTENT_SQL, rawJsonSql } from './messageContent';
import { mentionsFrom } from './messageExtras';
import { displayNameSql } from './names';
import { visibleMessageSql } from './privacy';

/** Tokens (words) of context FTS5 keeps around matches in a result snippet. */
const SNIPPET_TOKENS = 14;
/** Snippet length for filter-only searches (no words to centre on). */
const PLAIN_SNIPPET_CHARS = 160;
/** Time direction per sort; relevance has no score without words, so a filter-only search lists newest first. */
const TIME_ORDER: Readonly<Record<SearchSort, 'ASC' | 'DESC'>> = { newest: 'DESC', oldest: 'ASC', relevance: 'DESC' };

/** Builds literal quoted FTS5 word phrases requiring all words. Final in-progress words match prefixes; operators and punctuation remain literal. */
export function ftsQuery(text: string): string | null {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  return words.map((w, i) => `"${w.replace(/"/g, '""')}"${i === words.length - 1 ? '*' : ''}`).join(' ');
}

const HAS_CLAUSES: Readonly<Record<HasKind, string>> = {
  link: CONTENT_SQL.link,
  file: CONTENT_SQL.file,
  image: CONTENT_SQL.image,
  video: CONTENT_SQL.video,
  audio: CONTENT_SQL.audio,
  voice: CONTENT_SQL.voice,
  sticker: CONTENT_SQL.sticker,
  poll: CONTENT_SQL.poll,
  forward: CONTENT_SQL.forward,
  embed: `json_array_length(${rawJsonSql('$.embeds')}) > 0`,
};

const IS_CLAUSES: Readonly<Record<IsKind, string>> = {
  edited: 'm.edited_ts IS NOT NULL',
  deleted: 'm.deleted_at IS NOT NULL',
};

/** SQL for the query's operators (see @shared/searchQuery); `words` is the free text left for FTS. */
export interface SearchFilters {
  words: string;
  where: string[];
  params: (string | number)[];
}

/** One operator as SQL over `m` (messages), `c` (its channel) and `u` (its author). */
function termSql(t: SearchTerm): { sql: string; params: (string | number)[] } {
  switch (t.key) {
    case 'from': {
      const id = mentionedUserId(t.value);
      if (id) return { sql: 'm.author_id = ?', params: [id] };
      const like = `%${t.value.replace(/^@/, '')}%`;
      // Username, display name, or a server nickname they have anywhere.
      return {
        sql: '(u.username LIKE ? OR u.global_name LIKE ? OR EXISTS (SELECT 1 FROM members mb WHERE mb.user_id = m.author_id AND mb.nick LIKE ?))',
        params: [like, like, like],
      };
    }
    case 'in':
      // A channel includes its threads.
      return {
        sql: `(c.name LIKE ? OR (c.kind IN (${THREAD_KINDS_SQL}) AND c.parent_id IN (SELECT id FROM channels WHERE name LIKE ?)))`,
        params: [`%${t.value}%`, `%${t.value}%`],
      };
    case 'server':
      return { sql: 'c.guild_id IN (SELECT id FROM guilds WHERE name LIKE ?)', params: [`%${t.value}%`] };
    case 'plugin':
      return searchTokenCondition(t.token, t.value);
    case 'has':
      return { sql: HAS_CLAUSES[t.value], params: [] };
    case 'is':
      return { sql: IS_CLAUSES[t.value], params: [] };
    case 'before':
      return { sql: 'm.ts < ?', params: [t.period.start] };
    case 'after':
      return { sql: 'm.ts >= ?', params: [t.period.end] };
    case 'during':
      return { sql: '(m.ts >= ? AND m.ts < ?)', params: [t.period.start, t.period.end] };
  }
}

/** Operators that can't apply are left out here; the renderer shows them from the same parse. */
export function parseSearch(text: string): SearchFilters {
  const parsed = parseSearchQuery(text, searchTokenKeys());
  const where: string[] = [];
  const params: (string | number)[] = [];
  for (const t of parsed.terms) {
    const s = termSql(t);
    // A NULL (an unknown author's missing name) is "no match", so its negation must include the row.
    where.push(t.negated ? `NOT IFNULL(${s.sql}, 0)` : s.sql);
    params.push(...s.params);
  }
  return { words: parsed.words, where, params };
}

/** A hit as selected: its mentions still JSON. */
type HitRow = Omit<SearchHit, 'mentions'> & { mentionsJson: string | null };

/** The first `limit` matches in `sort` order: by time, or best first (bm25) when there are words to score. */
export function searchMessages(db: Db, text: string, limit: number, sort: SearchSort): SearchHit[] {
  const f = parseSearch(text);
  const q = ftsQuery(f.words);
  if (!q && !f.where.length) return [];
  const filters = ` AND ${[...f.where, visibleMessageSql('m')].join(' AND ')}`;
  const select = `SELECT m.id AS messageId, m.channel_id AS channelId, COALESCE(c.name, m.channel_id) AS channelName,
                         ${displayNameSql('m.author_id', 'm.channel_id')} AS authorName, m.ts, ${rawJsonSql('$.mentions')} AS mentionsJson`;
  const joins = 'LEFT JOIN channels c ON c.id = m.channel_id LEFT JOIN users u ON u.id = m.author_id';
  if (q) {
    const hits = (fts: string, from: string): string =>
      `${select}, snippet(${fts}, 0, '${SEARCH_MATCH_START}', '${SEARCH_MATCH_END}', '…', ${SNIPPET_TOKENS}) AS snippet, bm25(${fts}) AS score
       ${from} ${joins} WHERE ${fts} MATCH ?${filters}`;
    // Deduplicates content, derived-text and link-text hits by best match. Applies requested ordering before limiting results.
    const sources = [
      hits('fts_messages', 'FROM fts_messages f JOIN messages m ON m.seq = f.rowid'),
      hits('fts_derived_texts', 'FROM fts_derived_texts fd JOIN derived_texts d ON d.seq = fd.rowid JOIN messages m ON m.id = d.message_id'),
      hits('fts_links', 'FROM fts_links fl JOIN message_links ml ON ml.link_id = fl.rowid JOIN messages m ON m.id = ml.message_id'),
    ];
    const rows = db
      .prepare(
        `SELECT messageId, channelId, channelName, authorName, ts, mentionsJson, snippet, MIN(score) AS score FROM (
           ${sources.join(' UNION ALL ')}
         ) GROUP BY messageId ORDER BY ${sort === 'relevance' ? 'score' : `ts ${TIME_ORDER[sort]}`} LIMIT ?`,
      )
      .all(...sources.flatMap(() => [q, ...f.params]), limit) as (HitRow & { score: number })[];
    return rows.map(({ score: _score, mentionsJson, ...hit }) => ({ ...hit, mentions: mentionsFrom(mentionsJson) }));
  }
  const rows = db
    .prepare(`${select}, m.content AS snippet FROM messages m ${joins} WHERE 1${filters} ORDER BY m.ts ${TIME_ORDER[sort]} LIMIT ?`)
    .all(...f.params, limit) as HitRow[];
  // Cut here, not in SQL, so Discord tokens stay whole.
  return rows.map(({ mentionsJson, ...hit }) => ({ ...hit, snippet: snippet(hit.snippet ?? '', null, PLAIN_SNIPPET_CHARS), mentions: mentionsFrom(mentionsJson) }));
}
