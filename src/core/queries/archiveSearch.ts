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
  /** Excludes deleted messages and messages whose text was pruned. Defaults to false. */
  excludeRemoved?: boolean;
  /** 1..ARCHIVE_SEARCH_MAX. */
  limit: number;
  /** Omitted means hosted. Source channels must also satisfy channel and time scope. */
  reader?: AiReader;
}

export interface ArchiveSearchHit { messageId: string; channelId: string; ts: number }

/** Shared scope, live privacy and provider policy, evaluated on each index candidate. */
export function archiveSearchScope(opts: Omit<ArchiveSearchOptions, 'limit'>, sources?: AiSources): { sql: string; params: (string | number)[] } {
  const policy = sources?.sql('m.channel_id', opts.reader ?? 'hosted') ?? hostedMayReadSql('m.channel_id');
  const where = [visibleMessageSql('m'), policy, 'm.channel_id IN (SELECT value FROM json_each(?))'];
  const params: (string | number)[] = [JSON.stringify(opts.channelIds)];
  if (opts.authorIds !== undefined) {
    where.push('m.author_id IN (SELECT value FROM json_each(?))');
    params.push(JSON.stringify(opts.authorIds));
  }
  if (opts.since !== undefined) { where.push('m.ts >= ?'); params.push(opts.since); }
  if (opts.until !== undefined) { where.push('m.ts <= ?'); params.push(opts.until); }
  if (opts.excludeRemoved) where.push('m.deleted_at IS NULL', 'm.pruned_at IS NULL');
  return { sql: where.join(' AND '), params };
}

/** Link preview text matches only when a supplying share (alias `s`) satisfies the same scope. */
export function metadataSearchScope(scope: { sql: string; params: (string | number)[] }): { sql: string; params: (string | number)[] } {
  return { sql: `EXISTS (SELECT 1 FROM messages m WHERE m.id = s.id AND ${scope.sql})`, params: scope.params };
}

/** Matches any distinctive word, best match first, deduplicated across indexes. Ignores stopwords and short words; no distinctive words means no hits. Filter tokens remain literal text. */
export function archiveSearch(db: Db, query: string, opts: ArchiveSearchOptions, sources?: AiSources): ArchiveSearchHit[] {
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > ARCHIVE_SEARCH_MAX) {
    throw new RangeError(`Archive search limit must be between 1 and ${ARCHIVE_SEARCH_MAX}.`);
  }
  const q = ftsQuery(query);
  if (!q || !opts.channelIds.length) return [];
  const scope = archiveSearchScope(opts, sources);
  const union = searchIndexUnion(q, (fts) => `SELECT m.id AS messageId, m.channel_id AS channelId, m.ts, bm25(${fts}) AS score`, '', ` AND ${scope.sql}`, scope.params,
    metadataSearchScope(scope));
  return db.prepare(`SELECT messageId, channelId, ts FROM (${union.sql}) GROUP BY messageId ORDER BY MIN(score) LIMIT ?`)
    .all(...union.params, opts.limit) as ArchiveSearchHit[];
}
