import { describe, expect, it } from 'vitest';
import { rollupRange, ROLLUP_FIRST_DAY, ROLLUP_LAST_DAY, ROLLUP_FIRST_TS, ROLLUP_LAST_TS } from '../src/plugin-sdk/core/rollupRange';
import { MS_PER_DAY } from '@shared/units';

describe('shared rollup ranges', () => {
  it('uses named unbounded sentinels without converting impossible dates', () => {
    expect(rollupRange()).toMatchObject({ start: ROLLUP_FIRST_TS, end: ROLLUP_LAST_TS, first: ROLLUP_FIRST_DAY, last: ROLLUP_LAST_DAY, boundaryDays: [] });
  });
  it('keeps partial days live and includes exact whole-day boundaries', () => {
    const first = Date.UTC(2026, 0, 1), second = first + MS_PER_DAY, third = second + MS_PER_DAY;
    expect(rollupRange(first, third)).toMatchObject({ start: first, end: third, first: '2026-01-01', last: '2026-01-03' });
    expect(rollupRange(first + 1, third - 1)).toMatchObject({ start: second, end: second, boundaryDays: ['2026-01-01', '2026-01-02'] });
    expect(() => rollupRange(Infinity)).toThrow('Invalid rollup range');
  });
});
