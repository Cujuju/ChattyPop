// Rules started by time instead of a message: daily at a time, every few hours, or when the app opens after an
// absence. They act on a stretch of time over the rule's channels.
import { MS_PER_DAY, MS_PER_HOUR } from './units';

export type TimedTrigger =
  /** Each listed weekday (0 = Sunday) at local "HH:MM". */
  | { kind: 'daily'; at: string; days: number[] }
  /** Every `hours` hours, counted from the rule's last scheduled run (or from when it was turned on). */
  | { kind: 'every'; hours: number }
  /** Once per app start, when ChattyPop was closed at least `awayHours` hours. */
  | { kind: 'appStart'; awayHours: number };
export type TimedTriggerKind = TimedTrigger['kind'];
export const TIMED_TRIGGER_KINDS: readonly TimedTriggerKind[] = ['daily', 'every', 'appStart'];
export const isTimedTrigger = (t: { kind: string }): t is TimedTrigger =>
  (TIMED_TRIGGER_KINDS as readonly string[]).includes(t.kind);

export const TIMED_HOURS_MIN = 1;
/** A week: longer absences are read through the Archive. */
export const TIMED_HOURS_MAX = 168;
/** A run owed for days (the app was closed) covers at most a week, the catch-up horizon. */
export const TIMED_MAX_LOOKBACK_MS = 7 * MS_PER_DAY;
/** A new daily rule: the start of a working day. */
export const DEFAULT_DAILY_AT = '08:00';
/** A new "every" rule: a few times a day. */
export const DEFAULT_EVERY_HOURS = 6;
/** A new app-start rule: a night away. */
export const DEFAULT_AWAY_HOURS = 8;
const DAILY_AT = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAYS_PER_WEEK = 7;
/** Every weekday, Sunday first (Date.getDay order). */
export const ALL_DAYS: readonly number[] = Array.from({ length: DAYS_PER_WEEK }, (_, d) => d);
/** Run keys of timed runs start with this, so a rule's message runs never count as its last timed run. */
export const TIMED_RUN_PREFIX = 'time:';
/**
 * A timed run of one action alone (another's plugin was off, or it catches up) has this and its action id after its key.
 * A run without it ran every action of the rule.
 */
export const TIMED_RUN_ACTION_MARK = '#';
/**
 * Run keys of an action catching up alone after sitting out a scheduled run start with this. They advance that action
 * only: the rule's schedule stays counted from its last scheduled run.
 */
export const TIMED_CATCH_UP_PREFIX = `${TIMED_RUN_PREFIX}catchUp:`;

export function newTimedTrigger(kind: TimedTriggerKind): TimedTrigger {
  switch (kind) {
    case 'daily':
      return { kind, at: DEFAULT_DAILY_AT, days: [...ALL_DAYS] };
    case 'every':
      return { kind, hours: DEFAULT_EVERY_HOURS };
    case 'appStart':
      return { kind, awayHours: DEFAULT_AWAY_HOURS };
  }
}

const inHours = (n: number): boolean => Number.isInteger(n) && n >= TIMED_HOURS_MIN && n <= TIMED_HOURS_MAX;

/** Why a timed trigger can't run as written, or null. */
export function timedTriggerError(t: TimedTrigger): string | null {
  switch (t.kind) {
    case 'daily':
      if (!DAILY_AT.test(t.at)) return 'Pick the time of day it runs.';
      return t.days.length && t.days.every((d) => Number.isInteger(d) && d >= 0 && d < DAYS_PER_WEEK)
        ? null
        : 'Pick the days it runs.';
    case 'every':
      return inHours(t.hours) ? null : `Run every ${TIMED_HOURS_MIN} to ${TIMED_HOURS_MAX} hours.`;
    case 'appStart':
      return inHours(t.awayHours) ? null : `Pick an absence of ${TIMED_HOURS_MIN} to ${TIMED_HOURS_MAX} hours.`;
  }
}

/** The latest time at or before `now` that a daily trigger was due (local time, on one of `days`; any when empty). */
export function lastDailyDue(now: number, at: string, days: readonly number[]): number {
  const [h, m] = at.split(':').map(Number) as [number, number];
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d.getTime() > now) d.setDate(d.getDate() - 1);
  // At most a week back finds a listed weekday.
  for (let i = 0; i < DAYS_PER_WEEK && days.length && !days.includes(d.getDay()); i++) d.setDate(d.getDate() - 1);
  return d.getTime();
}

export interface TimedState {
  now: number;
  /** When the rule was turned on: it never covers time before. */
  armedAt: number;
  /** This action's last timed run, or null. */
  lastRunAt: number | null;
  /** The rule's last scheduled timed run of any of its actions (catch-ups excluded), or null. */
  ruleRunAt: number | null;
  /** When this app session started, and when the previous one was last seen. */
  sessionStart: number;
  lastSeenAt: number;
  /** An app-start rule already considered this session. */
  appStartDone: boolean;
  /** Where an app-start window this action still owed at an earlier quit starts (its plugin was off), or null. */
  owedSince: number | null;
  /**
   * Where coverage of the rule's channels (a summary of each), contiguous from `sinceTs`, ends; null for none. An
   * app-start run starts after it, since that time is already covered.
   */
  coveredFrom(sinceTs: number): number | null;
}

/** What a timed rule owes now: the run's key (once per due time) and where its range starts; null when nothing is due. */
export function dueWindow(t: TimedTrigger, s: TimedState): { key: string; sinceTs: number } | null {
  const floor = s.now - TIMED_MAX_LOOKBACK_MS;
  const from = Math.max(s.lastRunAt ?? s.armedAt, s.armedAt);
  switch (t.kind) {
    case 'daily': {
      const due = lastDailyDue(s.now, t.at, t.days);
      return due > from ? { key: `${TIMED_RUN_PREFIX}daily:${due}`, sinceTs: Math.max(from, floor) } : null;
    }
    case 'every': {
      const scheduled = Math.max(s.ruleRunAt ?? s.armedAt, s.armedAt);
      // Sat out the rule's last scheduled run: catches up now, then runs with the others.
      if (from < scheduled) return { key: `${TIMED_CATCH_UP_PREFIX}${scheduled}`, sinceTs: Math.max(from, floor) };
      const due = scheduled + t.hours * MS_PER_HOUR;
      return due <= s.now ? { key: `${TIMED_RUN_PREFIX}every:${due}`, sinceTs: Math.max(from, floor) } : null;
    }
    case 'appStart': {
      // Turned on during this session: its first app start is the next one.
      if (s.appStartDone || s.armedAt > s.sessionStart) return null;
      if (s.owedSince === null && s.sessionStart - s.lastSeenAt < t.awayHours * MS_PER_HOUR) return null;
      const from = Math.max(s.owedSince ?? s.lastSeenAt, s.armedAt, floor);
      const sinceTs = Math.max(from, s.coveredFrom(from) ?? from);
      return sinceTs < s.now ? { key: `${TIMED_RUN_PREFIX}start:${s.sessionStart}`, sinceTs } : null;
    }
  }
}

/** One line for lists: "Every day at 08:00", "Every 6 hours", "When ChattyPop opens after 8 h away". */
export function timedTriggerText(t: TimedTrigger, dayNames: readonly string[]): string {
  switch (t.kind) {
    case 'daily':
      return `${
        t.days.length < DAYS_PER_WEEK
          ? [...t.days]
              .sort((a, b) => a - b)
              .map((d) => dayNames[d])
              .join(', ')
          : 'Every day'
      } at ${t.at}`;
    case 'every':
      return `Every ${t.hours} ${t.hours === 1 ? 'hour' : 'hours'}`;
    case 'appStart':
      return `When ChattyPop opens after ${t.awayHours} h away`;
  }
}

/** What a timed rule's actions cover, for its editor. */
export const timedCoverText = (t: TimedTrigger, appStart = 'Since you were last here, after already covered time; at most a week'): string =>
  t.kind === 'appStart'
    ? appStart
    : 'Since its last run; at most a week';

/** Weekday labels in Date.getDay order. */
export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
