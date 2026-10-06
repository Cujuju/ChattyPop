// Local-time labels, DOM-free (tests import them); ui/format.ts re-exports them.
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MIN } from '@shared/units';

// Undefined locale = the user's.
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const SHORT_DATE = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const YEAR_DATE = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const SHORT_DATE_TIME = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const WEEKDAY_DATE_TIME = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const WEEKDAY_DATE = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

/** "14:05". */
export const clockTime = (ms: number): string => CLOCK.format(ms);
/** "3 Mar". */
export const shortDate = (ms: number): string => SHORT_DATE.format(ms);
/** With the year: for spans that can cross years. */
export const yearDate = (ms: number): string => YEAR_DATE.format(ms);
/** "3 Mar, 14:05". */
export const shortDateTime = (ms: number): string => SHORT_DATE_TIME.format(ms);
/** "Tue 3 Mar, 14:05". */
export const weekdayDateTime = (ms: number): string => WEEKDAY_DATE_TIME.format(ms);
/** "Tue 3 Mar". */
export const weekdayDate = (ms: number): string => WEEKDAY_DATE.format(ms);

const MESSAGE_DATE_TIME = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
/** A message's time as Discord's header shows it: "14:05" today, "Yesterday at 14:05", else "26/09/2026, 14:05". `today`: local midnight. */
export function messageTime(ms: number, today: number): string {
  if (ms >= today) return clockTime(ms);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  return ms >= yesterday.getTime() ? `Yesterday at ${clockTime(ms)}` : MESSAGE_DATE_TIME.format(ms);
}

const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
/** Weekday-age window excludes repeated current weekdays. */
const WEEKDAY_SPAN_DAYS = 6;

/** Formats DM-style ages: now, minutes, hours, weekday, day/month and differing years. today is local midnight. */
export function listAge(ms: number, now: number, today: number): string {
  const age = Math.max(0, now - ms);
  if (age < MS_PER_MIN) return 'now';
  if (age < MS_PER_HOUR) return `${Math.floor(age / MS_PER_MIN)}m`;
  if (age < MS_PER_DAY) return `${Math.floor(age / MS_PER_HOUR)}h`;
  const weekStart = new Date(today);
  weekStart.setDate(weekStart.getDate() - WEEKDAY_SPAN_DAYS);
  if (ms >= weekStart.getTime()) return WEEKDAY.format(ms);
  return new Date(ms).getFullYear() === new Date(now).getFullYear() ? shortDate(ms) : yearDate(ms);
}
