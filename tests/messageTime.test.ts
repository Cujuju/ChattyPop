import { describe, expect, it } from 'vitest';
import { clockTime, messageTime } from '../src/renderer/src/ui/dates';

const midnight = (y: number, m: number, d: number): number => new Date(y, m, d).getTime();
const at = (y: number, m: number, d: number, h: number, min: number): number => new Date(y, m, d, h, min).getTime();

describe('messageTime', () => {
  const today = midnight(2026, 8, 28);

  it('shows only the time for today', () => {
    const ms = at(2026, 8, 28, 0, 0);
    expect(messageTime(ms, today)).toBe(clockTime(ms));
  });

  it('says Yesterday for the previous local day', () => {
    const ms = at(2026, 8, 27, 23, 59);
    expect(messageTime(ms, today)).toBe(`Yesterday at ${clockTime(ms)}`);
    expect(messageTime(at(2026, 8, 27, 0, 0), today)).toMatch(/^Yesterday at /);
  });

  it('dates anything older', () => {
    const label = messageTime(at(2026, 8, 26, 23, 59), today);
    expect(label).not.toMatch(/Yesterday/);
    expect(label).toContain('2026');
  });

  it('counts yesterday by the calendar across a DST change', () => {
    // Europe and North America change clocks in March; the day before is still one calendar day back.
    const dstToday = midnight(2026, 2, 30);
    expect(messageTime(at(2026, 2, 29, 0, 30), dstToday)).toMatch(/^Yesterday at /);
  });
});
