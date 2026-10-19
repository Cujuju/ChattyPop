import type Database from 'better-sqlite3-multiple-ciphers';
import type { FoldResult, ReadFold } from './protocol';

/** Re-fold only keys affected by a replacement, including keys disappearing from the new partition. */
export function foldRollup(db: Database.Database, fold: ReadFold, part: { channelId: string; day: string }, rows: Record<string, unknown>[]): FoldResult {
  const quoted = (column: string) => `"${column}"`;
  const { table, keys, values, orderBy } = fold;
  const old = db.prepare(`SELECT ${keys.map(quoted).join(', ')} FROM "${table}" WHERE channel_id = ? AND day = ?`).all(part.channelId, part.day) as Record<string, unknown>[];
  const touched = new Map<string, Record<string, unknown>>();
  for (const row of [...old, ...rows]) {
    const key = Object.fromEntries(keys.map((key) => [key, row[key]]));
    touched.set(JSON.stringify(key), key);
  }
  if (!touched.size) return { keys: [], rows: [] };
  const columns = [...keys, ...Object.keys(values)];
  const extract = (names: string[]) => names.map((key) => `json_extract(value, '$.${key}') AS "${key}"`).join(', ');
  const expressions = Object.entries(values).map(([column, aggregate]) => aggregate === 'latest' || aggregate === 'earliest'
    ? `MAX(CASE WHEN __cp_${aggregate} = 1 THEN "${column}" END) AS "${column}"`
    : `${aggregate.toUpperCase()}("${column}") AS "${column}"`);
  const ranks = ['latest', 'earliest'].filter((operation) => Object.values(values).includes(operation as 'latest' | 'earliest'))
    .map((operation) => `ROW_NUMBER() OVER (PARTITION BY ${keys.map(quoted).join(', ')}
      ORDER BY ${[orderBy!, ...columns.filter((c) => c !== orderBy)].map((c) => `${quoted(c)} ${operation === 'latest' ? 'DESC' : 'ASC'}`).join(', ')}) AS __cp_${operation}`);
  const result = db.prepare(`WITH keys AS (SELECT ${extract(keys)} FROM json_each(@keys)),
    remaining AS (
      SELECT ${columns.map((column) => `r."${column}"`).join(', ')} FROM keys k CROSS JOIN "${table}" r
        ON r.channel_id = @channel AND ${keys.map((key) => `r."${key}" = k."${key}"`).join(' AND ')} AND r.day != @day
      UNION ALL SELECT ${extract(columns)} FROM json_each(@rows)
    ), ranked AS (SELECT *${ranks.length ? ', ' + ranks.join(', ') : ''} FROM remaining)
    SELECT ${[...keys.map(quoted), ...expressions].join(', ')} FROM ranked GROUP BY ${keys.map(quoted).join(', ')}`)
    .all({ keys: JSON.stringify([...touched.values()]), rows: JSON.stringify(rows), channel: part.channelId, day: part.day }) as Record<string, unknown>[];
  return { keys: [...touched.values()], rows: result };
}
