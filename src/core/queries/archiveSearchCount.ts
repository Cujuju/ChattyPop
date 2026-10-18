// Grouped archive counts share search's scope, text indexes and live privacy.
import type { Db } from '../db';
import { ftsQuery } from '../ai/tools';
import { archiveSearchScope, type ArchiveSearchOptions } from './archiveSearch';
import { displayNameSql } from './names';
import { searchIndexUnion } from './searchIndexes';

/** Bounds returned aggregates without capping the messages counted. */
export const ARCHIVE_SEARCH_GROUPS_MAX = 100;
/** SQLite's unixepoch modifier takes seconds; archive timestamps are milliseconds. */
const MS_PER_SECOND = 1000;
const LOCAL_DATE = `m.ts / ${MS_PER_SECOND}, 'unixepoch', 'localtime'`;

const GROUPS = {
  author: { key: 'm.author_id', name: `max(${displayNameSql('m.author_id', 'm.channel_id')})`, username: 'max(COALESCE(u.username, m.author_id))' },
  channel: { key: 'm.channel_id', name: 'c.name', username: 'NULL' },
  day: { key: `strftime('%Y-%m-%d', ${LOCAL_DATE})` },
  hour: { key: `strftime('%H', ${LOCAL_DATE})` },
  weekday: { key: `strftime('%w', ${LOCAL_DATE})` },
} as const;

export type ArchiveSearchGroup = keyof typeof GROUPS;

export interface ArchiveSearchCount {
  /** Author/channel id, local YYYY-MM-DD, hour 00..23, or weekday 0..6 (Sunday first). */
  key: string;
  count: number;
  /** Maximum matching author display name, channel name, or the time bucket key. */
  name: string;
  /** Author groups only; null for other groups. */
  username: string | null;
}

/** null query counts all scoped messages, including textless messages. limit bounds groups only. */
export function archiveSearchCount(db: Db, query: string | null, opts: ArchiveSearchOptions, group: ArchiveSearchGroup): ArchiveSearchCount[] {
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > ARCHIVE_SEARCH_GROUPS_MAX) {
    throw new RangeError(`Archive count limit must be between 1 and ${ARCHIVE_SEARCH_GROUPS_MAX}.`);
  }
  if (!Object.hasOwn(GROUPS, group)) throw new RangeError('Unknown archive count group.');
  const q = query === null ? null : ftsQuery(query);
  if ((query !== null && !q) || !opts.channelIds.length) return [];
  const scope = archiveSearchScope(opts);
  const matches = q
    ? searchIndexUnion(q, () => 'SELECT m.id', '', ` AND ${scope.sql}`, scope.params)
    : { sql: `SELECT m.id FROM messages m WHERE ${scope.sql}`, params: scope.params };
  const spec = GROUPS[group];
  const name = 'name' in spec ? spec.name : spec.key;
  const username = 'username' in spec ? spec.username : 'NULL';
  return db.prepare(`WITH matched AS MATERIALIZED (SELECT DISTINCT id FROM (${matches.sql}))
    SELECT ${spec.key} AS key, count(*) AS count, ${name} AS name, ${username} AS username
    FROM matched JOIN messages m ON m.id = matched.id
    JOIN channels c ON c.id = m.channel_id LEFT JOIN users u ON u.id = m.author_id
    GROUP BY ${spec.key} ORDER BY count DESC, ${spec.key} LIMIT ?`)
    .all(...matches.params, opts.limit) as ArchiveSearchCount[];
}
