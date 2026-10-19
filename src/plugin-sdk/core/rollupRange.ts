import { MS_PER_DAY } from '@shared/units';

export const ROLLUP_FIRST_TS = 0; // Discord timestamps follow the Unix epoch.
export const ROLLUP_LAST_TS = Number.MAX_SAFE_INTEGER; // Unbounded live comparisons cover every representable archive millisecond.
export const ROLLUP_FIRST_DAY = '0000-01-01'; // Sorts before every Discord UTC partition.
export const ROLLUP_LAST_DAY = '9999-12-31'; // Sorts after every Discord UTC partition.

/** Whole UTC partitions and live boundary days for an inclusive start and exclusive end. Null means unbounded. */
export function rollupRange(since?: number | null, until?: number | null) {
  for (const ts of [since, until]) if (ts != null && (!Number.isFinite(ts) || !Number.isFinite(new Date(ts).getTime()))) throw new Error('Invalid rollup range');
  const day = (ts: number): string => new Date(ts).toISOString().slice(0, 'YYYY-MM-DD'.length);
  const start = since == null ? ROLLUP_FIRST_TS : Math.ceil(since / MS_PER_DAY) * MS_PER_DAY;
  const end = until == null ? ROLLUP_LAST_TS : Math.floor(until / MS_PER_DAY) * MS_PER_DAY;
  const first = since == null ? ROLLUP_FIRST_DAY : day(start);
  const last = until == null ? ROLLUP_LAST_DAY : day(end);
  const boundaryDays = [...new Set([since, until].flatMap((ts) => ts == null ? [] : [day(Math.floor(ts / MS_PER_DAY) * MS_PER_DAY)]))];
  return { start, end, first, last, boundaryDays, sql: `day >= '${first}' AND day < '${last}'` };
}
