import { describe, expect, it } from 'vitest';
import { REMINDER_PRESETS, localReminderTime, localReminderValue, reminderPreset, reminderTime, savedTimestamp } from '@shared/savedMessages';
describe('reminder times', () => {
  it('offers ten- and thirty-minute reminders first and resolves both from the current clock', () => {
    expect(REMINDER_PRESETS.slice(0, 2)).toEqual(['10m', '30m']);
    const now = new Date('2026-10-12T06:58:42.123Z');
    expect(reminderPreset('10m', now).toISOString()).toBe('2026-10-12T07:08:42.123Z');
    expect(reminderPreset('30m', now).toISOString()).toBe('2026-10-12T07:28:42.123Z');
  });
  it('validates future dates and refuses impossible ISO calendar dates', () => {
    const now = Date.parse('2026-10-10T10:00:00Z');
    expect(reminderTime('2026-10-10T10:01:00+00:00', now)).toBe('2026-10-10T10:01:00.000Z');
    expect(() => reminderTime('2026-10-10T10:00:00Z', now)).toThrow(/future/);
    expect(() => savedTimestamp('2026-02-30T10:00:00Z')).toThrow(/calendar/);
    expect(() => localReminderTime('2026-02-30T10:00', now)).toThrow(/does not exist/);
  });
  it('uses local morning/Monday dates, with Monday before 9am staying today', () => {
    const monday = new Date(2026, 9, 12, 8, 30);
    expect(localReminderValue(reminderPreset('monday', monday))).toBe('2026-10-12T09:00');
    expect(localReminderValue(reminderPreset('monday', new Date(2026, 9, 12, 9, 30)))).toBe('2026-10-19T09:00');
    expect(localReminderValue(reminderPreset('monday', new Date(2026, 9, 11, 10, 0)))).toBe('2026-10-12T09:00');
    expect(localReminderValue(reminderPreset('morning', new Date(2026, 9, 10, 10, 0)))).toBe('2026-10-11T09:00');
    expect(reminderPreset('30m', monday).getTime() - monday.getTime()).toBe(30 * 60_000);
  });
  it('round-trips local datetime input and refuses invalid dates', () => {
    expect(new Date(localReminderTime('2090-10-10T09:00')).getHours()).toBe(9);
    expect(() => localReminderTime('2090-13-10T09:00')).toThrow();
    expect(() => localReminderTime('2090-10-10T25:00')).toThrow();
  });
  it('uses local 9am across Pacific DST and rejects a spring-forward gap', () => {
    const previous = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      const before = new Date(2026, 2, 7, 10), morning = reminderPreset('morning', before);
      expect(before.getTimezoneOffset()).toBe(480); expect(morning.getTimezoneOffset()).toBe(420);
      expect(localReminderValue(morning)).toBe('2026-03-08T09:00');
      expect(morning.getTime() - before.getTime()).toBe(22 * 60 * 60_000);
      expect(() => localReminderTime('2026-03-08T02:30', Date.parse('2026-03-01T00:00:00Z'))).toThrow(/does not exist/);
      const fall = reminderPreset('morning', new Date(2026, 9, 31, 10));
      expect(localReminderValue(fall)).toBe('2026-11-01T09:00'); expect(fall.getTimezoneOffset()).toBe(480);
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  });
});
