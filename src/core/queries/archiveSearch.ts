// Scoped free-text search for plugins, with the app's index union and live privacy.
import type { Db } from '../db';
import { visibleMessageSql } from './privacy';
import { ftsQuery } from './search';
import { searchIndexUnion } from './searchIndexes';

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
}

export interface ArchiveSearchHit { messageId: string; channelId: string; ts: number }

/** Best match first, deduplicated across all three text indexes. Filter tokens remain literal free text. */
export function archiveSearch(db: Db, query: string, opts: ArchiveSearchOptions): ArchiveSearchHit[] {
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > ARCHIVE_SEARCH_MAX) {
    throw new RangeError(`Archive search limit must be between 1 and ${ARCHIVE_SEARCH_MAX}.`);
  }
  const q = ftsQuery(query);
  if (!q || !opts.channelIds.length) return [];
  const where = [visibleMessageSql('m'), 'm.channel_id IN (SELECT value FROM json_each(?))'];
  const params: (string | number)[] = [JSON.stringify(opts.channelIds)];
  if (opts.authorIds !== undefined) {
    where.push('m.author_id IN (SELECT value FROM json_each(?))');
    params.push(JSON.stringify(opts.authorIds));
  }
  if (opts.since !== undefined) { where.push('m.ts >= ?'); params.push(opts.since); }
  if (opts.until !== undefined) { where.push('m.ts <= ?'); params.push(opts.until); }
  const union = searchIndexUnion(q, (fts) => `SELECT m.id AS messageId, m.channel_id AS channelId, m.ts, bm25(${fts}) AS score`, '', ` AND ${where.join(' AND ')}`, params);
  return db.prepare(`SELECT messageId, channelId, ts FROM (${union.sql}) GROUP BY messageId ORDER BY MIN(score) LIMIT ?`)
    .all(...union.params, opts.limit) as ArchiveSearchHit[];
}
