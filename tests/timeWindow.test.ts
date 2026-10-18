// The time window picker's contract: presets resolve against the clock, fixed bounds stay put, and each reads short.
import { describe, expect, it } from 'vitest';
import { MS_PER_DAY, MS_PER_HOUR } from '@shared/units';

type TimeRange = { since: number | null; until: number | null };
type TimeWindow = { last: string } | TimeRange;
// A renderer module: imported by path so the node type-check doesn't follow it.
const timeWindowPath = '../src/renderer/src/ui/timeWindow';
const { TIME_PRESETS, isTimeRange, timeBounds, timeRangeLabel } = (await import(timeWindowPath)) as {
  TIME_PRESETS: readonly { id: string; label: string; ms: number }[];
  isTimeRange(w: TimeWindow): w is TimeRange;
  timeBounds(w: TimeWindow | null, now: number): TimeRange;
  timeRangeLabel(r: TimeRange): string;
};

const NOW = 100 * MS_PER_DAY;

describe('time windows', () => {
  it('offers the short presets the filter bars show', () => {
    expect(TIME_PRESETS.map((p) => p.label)).toEqual(['24h', '7d', '30d']);
  });

  it('starts a preset its length before now, open at the end; null and unknown presets are unbounded', () => {
    expect(timeBounds({ last: '1d' }, NOW)).toEqual({ since: NOW - 24 * MS_PER_HOUR, until: null });
    expect(timeBounds({ last: '30d' }, NOW)).toEqual({ since: NOW - 30 * MS_PER_DAY, until: null });
    expect(timeBounds({ last: 'gone' }, NOW)).toEqual({ since: null, until: null });
    expect(timeBounds(null, NOW)).toEqual({ since: null, until: null });
  });

  it('keeps fixed bounds as given', () => {
    const range = { since: 5, until: 9 };
    expect(isTimeRange(range)).toBe(true);
    expect(isTimeRange({ last: '7d' })).toBe(false);
    expect(timeBounds(range, NOW)).toBe(range);
  });

  it('reads open bounds as Any, one bound as Since or Until, and both as a span', () => {
    expect(timeRangeLabel({ since: null, until: null })).toBe('Any');
    expect(timeRangeLabel({ since: NOW, until: null })).toMatch(/^Since /);
    expect(timeRangeLabel({ since: null, until: NOW })).toMatch(/^Until /);
    expect(timeRangeLabel({ since: NOW - 9 * MS_PER_DAY, until: NOW })).toContain(' – ');
  });
});
