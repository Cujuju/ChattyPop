// Scoped free-text search for plugins, with the app's index union and live privacy.
import type { Db } from '../db';
import { ftsQuery } from '../ai/tools';
import { visibleMessageSql } from './privacy';
import { searchIndexUnion } from './searchIndexes';
import type { AiReader, AiSources } from '../ai/readScope';
import { hostedMayReadSql } from '../channelPolicy';

/** Bounds plugin search results to a small set suitable for follow-up archive reads. */
export const ARCHIVE_SEARCH_MAX = 100;

export interface ArchiveSearchOptions {
  /** Only these channels; empty means no hits. */
  channelIds: readonly string[];
  authorIds?: readonly string[];
  /** Inclusive millisecond bounds. */
  since?: number;
  until?: number;
  /** 1..ARCHIVE_SEARCH_MAX. */
  limit: number;
  /** Omitted means hosted. Source channels must also satisfy channel and time scope. */
  reader?: AiReader;
}

export interface ArchiveSearchHit { messageId: string; channelId: string; ts: number }

/** Matches any distinctive word, best match first, deduplicated across indexes. Ignores stopwords and short words; no distinctive words means no hits. Filter tokens remain literal text. */
export function archiveSearch(db: Db, query: string, opts: ArchiveSearchOptions, sources?: AiSources): ArchiveSearchHit[] {
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > ARCHIVE_SEARCH_MAX) {
    throw new RangeError(`Archive search limit must be between 1 and ${ARCHIVE_SEARCH_MAX}.`);
  }
  const q = ftsQuery(query);
  if (!q || !opts.channelIds.length) return [];
  const policy = sources?.sql('m.channel_id', opts.reader ?? 'hosted') ?? hostedMayReadSql('m.channel_id');
  const where = [visibleMessageSql('m'), policy, 'm.channel_id IN (SELECT value FROM json_each(?))'];
  const params: (string | number)[] = [JSON.stringify(opts.channelIds)];
  if (opts.authorIds !== undefined) {
    where.push('m.author_id IN (SELECT value FROM json_each(?))');
    params.push(JSON.stringify(opts.authorIds));
  }
  if (opts.since !== undefined) { where.push('m.ts >= ?'); params.push(opts.since); }
  if (opts.until !== undefined) { where.push('m.ts <= ?'); params.push(opts.until); }
  const union = searchIndexUnion(q, (fts) => `SELECT m.id AS messageId, m.channel_id AS channelId, m.ts, bm25(${fts}) AS score`, '', ` AND ${where.join(' AND ')}`, params,
    { sql: `EXISTS (SELECT 1 FROM messages m WHERE m.id = s.id AND ${where.join(' AND ')})`, params });
  return db.prepare(`SELECT messageId, channelId, ts FROM (${union.sql}) GROUP BY messageId ORDER BY MIN(score) LIMIT ?`)
    .all(...union.params, opts.limit) as ArchiveSearchHit[];
}
