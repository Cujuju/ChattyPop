// A time window: a preset back from now, or fixed bounds; null is any time. Lists and chats filter by it.
import { MS_PER_DAY, MS_PER_HOUR } from '@shared/units';
import { shortDate, shortDateTime } from './dates';

/** Fixed bounds, inclusive ms; null leaves that end open. */
export interface TimeRange { since: number | null; until: number | null }
/** A preset (`last`: its id), resolved against the clock when read; or fixed bounds. */
export type TimeWindow = { last: string } | TimeRange;
/** A picker choice back from now. `label` is short: the picker sits in filter bars and headers. */
export interface TimePreset { id: string; label: string }

/** The standard presets: a day, a week and a month back from now. */
export const TIME_PRESETS = [
  { id: '1d', label: '24h', ms: 24 * MS_PER_HOUR },
  { id: '7d', label: '7d', ms: 7 * MS_PER_DAY },
  { id: '30d', label: '30d', ms: 30 * MS_PER_DAY },
] as const satisfies readonly (TimePreset & { ms: number })[];

export const isTimeRange = (w: TimeWindow): w is TimeRange => !('last' in w);

/** A window's bounds at `now`: a standard preset starts its length back, open at the end; an unknown one is unbounded. */
export function timeBounds(w: TimeWindow | null, now: number): TimeRange {
  if (!w) return { since: null, until: null };
  if (isTimeRange(w)) return w;
  const preset = TIME_PRESETS.find((p) => p.id === w.last);
  return { since: preset ? now - preset.ms : null, until: null };
}

/** A range under 2 days reads with its times; longer ones by date. */
const TIMES_UNDER_MS = 2 * MS_PER_DAY;

/** Fixed bounds as they read: "Since Oct 10", "Until Oct 9", "Oct 1 – Oct 9"; none is "Any". */
export function timeRangeLabel(r: TimeRange): string {
  if (r.since === null && r.until === null) return 'Any';
  const span = r.since !== null && r.until !== null ? r.until - r.since : Infinity;
  const at = (ms: number): string => (span < TIMES_UNDER_MS ? shortDateTime(ms) : shortDate(ms));
  if (r.since !== null && r.until !== null) return `${at(r.since)} – ${at(r.until)}`;
  return r.since !== null ? `Since ${at(r.since)}` : `Until ${at(r.until!)}`;
}
