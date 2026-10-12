import { describe, expect, it } from 'vitest';
import { BACKFILL_MAX_YEARS, DEFAULT_BACKFILL_HISTORY, backfillCutoffMs, clampBackfillAmount, normalizeArchiveSettings, type BackfillHistory, type BackfillUnit } from '@shared/archiveSettings';
import { backfillFraction } from '@shared/backfillProgress';
import { DISCORD_EPOCH_MS, snowflakeFromMs, snowflakeToMs } from '@shared/discord';
import { MS_PER_DAY } from '@shared/units';

const CHOICES: BackfillHistory[] = [{ unit: 'days', amount: 30 }, { unit: 'months', amount: 6 }, { unit: 'years', amount: 1 }, 'complete'];
const historyFrom = (stored: unknown): BackfillHistory => normalizeArchiveSettings(stored).backfillHistory;

describe('archive history normalization', () => {
  it.each(CHOICES)('round-trips the chosen history %j through stored JSON', (backfillHistory) => {
    const settings = normalizeArchiveSettings({ backfillHistory });
    expect(historyFrom(JSON.parse(JSON.stringify(settings)))).toEqual(backfillHistory);
  });

  it.each(CHOICES)('a valid new choice %j wins over the legacy days', (backfillHistory) => {
    expect(historyFrom({ backfillHistory, backfillDays: 7 })).toEqual(backfillHistory);
  });

  it.each([
    [7, 7], ['42', 42], [0, 1], [5000, 3650], [2.6, 3],
  ])('reads legacy days %j as %j days without keeping the legacy field', (backfillDays, amount) => {
    const settings = normalizeArchiveSettings({ backfillDays });
    expect(settings.backfillHistory).toEqual({ unit: 'days', amount });
    expect(settings).not.toHaveProperty('backfillDays');
  });

  it.each([
    ['days', 3650], ['months', 120], ['years', 10],
  ] as const)('clamps %s amounts to 1..%i and rounds whole units', (unit, max) => {
    expect(historyFrom({ backfillHistory: { unit, amount: 0 } })).toEqual({ unit, amount: 1 });
    expect(historyFrom({ backfillHistory: { unit, amount: max + 1 } })).toEqual({ unit, amount: max });
    expect(historyFrom({ backfillHistory: { unit, amount: '2.6' } })).toEqual({ unit, amount: 3 });
  });

  it.each([
    undefined, null, 'other', {}, { unit: 'weeks', amount: 2 }, { unit: 'days' },
    { unit: 'months', amount: 'unreadable' }, { unit: 'years', amount: Infinity }, { unit: 'years', amount: {} },
  ])('an invalid new choice %j falls back to legacy days, then the default', (backfillHistory) => {
    expect(historyFrom({ backfillHistory, backfillDays: 7 })).toEqual({ unit: 'days', amount: 7 });
    expect(historyFrom({ backfillHistory, backfillDays: 'unreadable' })).toEqual(DEFAULT_BACKFILL_HISTORY);
    expect(historyFrom({ backfillHistory })).toEqual(DEFAULT_BACKFILL_HISTORY);
  });

  it.each([undefined, null, 'unreadable'])('unset or unreadable settings %j use 30 days', (settings) => {
    expect(historyFrom(settings)).toEqual({ unit: 'days', amount: 30 });
  });

  it.each([
    ['days', 6, 6], ['months', 6, 6], ['years', 6, 6], ['months', 3650, 120], ['years', 30, 10],
  ] as const)('changing to %s keeps or clamps amount %i', (unit, amount, expected) => {
    expect(clampBackfillAmount(unit, amount)).toBe(expected);
  });

  it('restores a bounded default amount for every unit', () => {
    expect(clampBackfillAmount('days', DEFAULT_BACKFILL_HISTORY.amount)).toBe(30);
    expect(clampBackfillAmount('months', DEFAULT_BACKFILL_HISTORY.amount)).toBe(30);
    expect(clampBackfillAmount('years', DEFAULT_BACKFILL_HISTORY.amount)).toBe(BACKFILL_MAX_YEARS);
    expect(clampBackfillAmount('years', NaN)).toBe(BACKFILL_MAX_YEARS);
  });
});

describe('archive history cutoff', () => {
  it('subtracts days as elapsed days', () => {
    const now = Date.parse('2026-03-31T12:34:56.789Z');
    expect(backfillCutoffMs({ unit: 'days', amount: 30 }, now)).toBe(Date.parse('2026-03-01T12:34:56.789Z'));
  });

  it.each([
    ['months', 1, '2026-03-31', '2026-02-28'],
    ['months', 1, '2024-03-31', '2024-02-29'],
    ['months', 2, '2026-01-31', '2025-11-30'],
    ['months', 6, '2026-03-15', '2025-09-15'],
    ['years', 1, '2024-02-29', '2023-02-28'],
    ['years', 4, '2024-02-29', '2020-02-29'],
    ['years', 6, '2026-03-31', '2020-03-31'],
  ] as const)('subtracts calendar %s (%i) from %s, clamping to %s', (unit, amount, from, to) => {
    const time = 'T12:34:56.789Z';
    expect(backfillCutoffMs({ unit, amount }, Date.parse(from + time))).toBe(Date.parse(to + time));
  });

  it('complete history starts at the finite numeric Discord epoch', () => {
    const cutoff = backfillCutoffMs('complete', Date.parse('2026-03-31T00:00:00Z'));
    expect(cutoff).toBe(DISCORD_EPOCH_MS);
    expect(cutoff).toBe(Date.parse('2015-01-01T00:00:00Z'));
    expect(cutoff).toBe(snowflakeToMs('0'));
    expect(Number.isFinite(cutoff)).toBe(true);
    expect(JSON.parse(JSON.stringify(cutoff))).toBe(cutoff);
  });
});

describe('backfill progress window', () => {
  const now = Date.parse('2026-03-31T00:00:00Z');

  it.each(CHOICES)('uses channel creation for a channel younger than %j', (history) => {
    const created = snowflakeToMs(snowflakeFromMs(now - 10 * MS_PER_DAY));
    const cutoff = backfillCutoffMs(history, now);
    expect(backfillFraction(now, cutoff, created, now - 5 * MS_PER_DAY)).toBe(0.5);
    expect(backfillFraction(now, cutoff, created, created)).toBe(1);
  });

  it.each(['days', 'months', 'years'] satisfies BackfillUnit[])('uses the cutoff for an older channel with %s', (unit) => {
    const cutoff = backfillCutoffMs({ unit, amount: 1 }, now);
    const reached = now - (now - cutoff) / 2;
    expect(backfillFraction(now, cutoff, DISCORD_EPOCH_MS, reached)).toBe(0.5);
  });

  it('measures complete history across the channel lifetime', () => {
    const created = Date.parse('2020-01-01T00:00:00Z');
    const reached = now - (now - created) / 2;
    expect(backfillFraction(now, backfillCutoffMs('complete', now), created, reached)).toBe(0.5);
  });

  it('clamps progress and guards empty or future windows', () => {
    const cutoff = now - MS_PER_DAY;
    expect(backfillFraction(now, cutoff, DISCORD_EPOCH_MS, now + MS_PER_DAY)).toBe(0);
    expect(backfillFraction(now, cutoff, DISCORD_EPOCH_MS, cutoff - MS_PER_DAY)).toBe(1);
    expect(backfillFraction(now, cutoff, now, now)).toBe(1);
    expect(backfillFraction(now, cutoff, now + MS_PER_DAY, now)).toBe(1);
    expect(backfillFraction(now, now, DISCORD_EPOCH_MS, now)).toBe(1);
  });
});
