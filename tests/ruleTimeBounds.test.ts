// Timed rule windows: one due per scheduled local day across DST changes, and no window reaching past the lookback horizon.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TIMED_HOURS_MAX, TIMED_MAX_LOOKBACK_MS, dueWindows, lastDailyDue, type TimedState, type TimedTrigger } from '@shared/ruleTime';
import { MS_PER_DAY, MS_PER_HOUR } from '@shared/units';

/** A zone that springs forward 8 Mar 2026 02:00 → 03:00 and falls back 1 Nov 2026 02:00 → 01:00. */
const DST_ZONE = 'America/Los_Angeles';
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
/** Hours a spring-forward gap skips in DST_ZONE. */
const GAP_HOURS = 1;

const local = (month: number, day: number, h: number, m = 0): number => new Date(2026, month, day, h, m).getTime();
const state = (o: Partial<TimedState> & Pick<TimedState, 'now'>): TimedState => ({
  armedAt: o.now - 60 * MS_PER_DAY,
  lastRunAt: null,
  ruleRunAt: o.lastRunAt ?? null,
  sessionStart: o.now,
  lastSeenAt: o.now,
  appStartDone: false,
  owedSince: null,
  coveredFrom: () => null,
  ...o,
});

describe('daily due times across DST changes', () => {
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.TZ;
    process.env.TZ = DST_ZONE;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  });

  const MARCH = 2;
  const OCTOBER = 9;
  const NOVEMBER = 10;

  it('owes one due per day when the spring gap skips the wall time, at the instant past the gap', () => {
    const daily: TimedTrigger = { kind: 'daily', at: '02:30', days: ALL_DAYS, backfillHours: 72 };
    const skipped = local(MARCH, 8, 2, 30);
    expect(skipped).toBe(local(MARCH, 8, 2 + GAP_HOURS, 30)); // the zone has no 02:30 that day
    const windows = dueWindows(daily, state({ now: local(MARCH, 8, 4), lastRunAt: local(MARCH, 6, 2, 30) }));
    expect(windows.map((w) => [w.sinceTs, w.untilTs])).toEqual([
      [local(MARCH, 6, 2, 30), local(MARCH, 7, 2, 30)],
      [local(MARCH, 7, 2, 30), skipped],
    ]);
    expect(lastDailyDue(skipped - 1, '02:30', ALL_DAYS)).toBe(local(MARCH, 7, 2, 30));
    expect(lastDailyDue(local(MARCH, 8, 4), '02:30', ALL_DAYS)).toBe(skipped);
  });

  it('keeps ordinary days whole around the spring gap', () => {
    const daily: TimedTrigger = { kind: 'daily', at: '01:30', days: ALL_DAYS, backfillHours: 72 };
    const windows = dueWindows(daily, state({ now: local(MARCH, 9, 4), lastRunAt: local(MARCH, 6, 1, 30) }));
    expect(windows.map((w) => w.untilTs)).toEqual([7, 8, 9].map((day) => local(MARCH, day, 1, 30)));
  });

  it('owes one due on the day a fall-back repeats the wall time', () => {
    for (const at of ['01:30', '02:30']) {
      const [h, m] = at.split(':').map(Number) as [number, number];
      const daily: TimedTrigger = { kind: 'daily', at, days: ALL_DAYS, backfillHours: 96 };
      const windows = dueWindows(daily, state({ now: local(NOVEMBER, 2, 4), lastRunAt: local(OCTOBER, 30, h, m) }));
      expect(windows.map((w) => w.untilTs)).toEqual([local(OCTOBER, 31, h, m), local(NOVEMBER, 1, h, m), local(NOVEMBER, 2, h, m)]);
    }
  });
});

describe('missed-time windows stay within the lookback horizon', () => {
  const now = new Date(2026, 8, 25, 9).getTime();
  const horizon = (s: TimedState): number => Math.max(s.armedAt, s.now - TIMED_MAX_LOOKBACK_MS);
  const triggers: TimedTrigger[] = [
    { kind: 'every', hours: TIMED_HOURS_MAX, backfillHours: TIMED_HOURS_MAX },
    { kind: 'every', hours: 100, backfillHours: TIMED_HOURS_MAX },
    { kind: 'every', hours: 1, backfillHours: TIMED_HOURS_MAX },
    { kind: 'daily', at: '08:00', days: [5], backfillHours: TIMED_HOURS_MAX },
    { kind: 'daily', at: '08:00', days: [1, 5], backfillHours: TIMED_HOURS_MAX },
    { kind: 'daily', at: '08:00', days: ALL_DAYS, backfillHours: TIMED_HOURS_MAX },
  ];

  it('starts every window at or after the horizon, first attempts included', () => {
    for (const t of triggers) {
      for (const s of [
        state({ now, armedAt: now - 30 * MS_PER_DAY }),
        state({ now, armedAt: now - 30 * MS_PER_DAY, lastRunAt: now - 20 * MS_PER_DAY }),
        state({ now, armedAt: now - 8 * MS_PER_DAY - 3 * MS_PER_HOUR }),
      ]) {
        const windows = dueWindows(t, s);
        expect(windows.length).toBeGreaterThan(0);
        for (const w of windows) {
          expect(w.sinceTs).toBeGreaterThanOrEqual(horizon(s));
          expect(w.sinceTs).toBeLessThan(w.untilTs);
        }
      }
    }
  });
});
