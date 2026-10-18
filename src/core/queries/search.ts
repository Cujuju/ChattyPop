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
import { searchIndexUnion } from './searchIndexes';

/**
 * About what a result row shows before it clamps (three lines of the search panel): a text this long or shorter shows
 * whole, its line breaks kept; a longer one as a window this long around its first match.
 */
const RESULT_TEXT_CHARS = 160;
const FIRST_MATCH = new RegExp(SEARCH_MATCH_START);
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

/** Each term's SQL, ANDed by the caller. */
function termsSql(terms: readonly SearchTerm[]): Pick<SearchFilters, 'where' | 'params'> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  for (const t of terms) {
    const s = termSql(t);
    // A NULL (an unknown author's missing name) is "no match", so its negation must include the row.
    where.push(t.negated ? `NOT IFNULL(${s.sql}, 0)` : s.sql);
    params.push(...s.params);
  }
  return { where, params };
}

/** Operators that can't apply are left out here; the renderer shows them from the same parse. */
export function parseSearch(text: string): SearchFilters {
  const parsed = parseSearchQuery(text, searchTokenKeys());
  return { words: parsed.words, ...termsSql(parsed.terms) };
}

/** The keys naming where a search looks; their SQL reads only `c` (the channel). */
const PLACE_KEYS: ReadonlySet<SearchTerm['key']> = new Set(['in', 'server']);

/** The query's `in:` and `server:` terms as SQL over `c` (channels): the channels its search looks in. */
export const placeSql = (text: string): Pick<SearchFilters, 'where' | 'params'> =>
  termsSql(parseSearchQuery(text, searchTokenKeys()).terms.filter((t) => PLACE_KEYS.has(t.key)));

/** A hit's text: whole when short, else cut around its first match (or from its start) with tokens, links and URLs whole. */
const resultText = (text: string): string => (text.length <= RESULT_TEXT_CHARS ? text : snippet(text, FIRST_MATCH, RESULT_TEXT_CHARS));

/** A hit as selected: its mentions still JSON, its text uncut, and its bm25 score when words were searched. */
export type HitRow = Omit<SearchHit, 'mentions'> & { mentionsJson: string | null; score?: number };

/** A search as one read-only statement, and how its rows become hits; null when the query asks for nothing. */
export interface SearchStatement {
  sql: string;
  params: (string | number)[];
  hits: (rows: readonly HitRow[]) => SearchHit[];
}

const toHits = (rows: readonly HitRow[]): SearchHit[] =>
  rows.map(({ mentionsJson, score: _score, ...hit }) => ({ ...hit, snippet: resultText(hit.snippet ?? ''), mentions: mentionsFrom(mentionsJson) }));

/** The first `limit` matches in `sort` order: by time, or best first (bm25) when there are words to score. */
export function searchStatement(text: string, limit: number, sort: SearchSort): SearchStatement | null {
  const f = parseSearch(text);
  const q = ftsQuery(f.words);
  if (!q && !f.where.length) return null;
  const filters = ` AND ${[...f.where, visibleMessageSql('m')].join(' AND ')}`;
  const select = `SELECT m.id AS messageId, m.channel_id AS channelId, COALESCE(c.name, m.channel_id) AS channelName,
                         m.author_id AS authorId, ${displayNameSql('m.author_id', 'm.channel_id')} AS authorName, u.avatar AS authorAvatar, m.ts, ${rawJsonSql('$.mentions')} AS mentionsJson`;
  const joins = 'LEFT JOIN channels c ON c.id = m.channel_id LEFT JOIN users u ON u.id = m.author_id';
  if (!q) {
    return { sql: `${select}, m.content AS snippet FROM messages m ${joins} WHERE 1${filters} ORDER BY m.ts ${TIME_ORDER[sort]} LIMIT ?`, params: [...f.params, limit], hits: toHits };
  }
  const hits = (fts: string): string => `${select}, highlight(${fts}, 0, '${SEARCH_MATCH_START}', '${SEARCH_MATCH_END}') AS snippet, bm25(${fts}) AS score`;
  // Deduplicates content, derived-text and link-text hits by best match. Applies requested ordering before limiting results.
  const union = searchIndexUnion(q, hits, joins, filters, f.params, {
    sql: `EXISTS (SELECT 1 FROM messages m ${joins} WHERE m.id = s.id${filters})`, params: f.params,
  });
  return {
    sql: `SELECT messageId, channelId, channelName, authorId, authorName, authorAvatar, ts, mentionsJson, snippet, MIN(score) AS score FROM (
            ${union.sql}
          ) GROUP BY messageId ORDER BY ${sort === 'relevance' ? 'score' : `ts ${TIME_ORDER[sort]}`} LIMIT ?`,
    params: [...union.params, limit],
    hits: toHits,
  };
}

/** searchStatement run on the calling connection. */
export function searchMessages(db: Db, text: string, limit: number, sort: SearchSort): SearchHit[] {
  const s = searchStatement(text, limit, sort);
  return s ? s.hits(db.prepare(s.sql).all(...s.params) as HitRow[]) : [];
}
