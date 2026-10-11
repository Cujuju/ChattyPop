// Timed rules run daily, periodically or on app return, acting over configured channel/time windows.
import { MS_PER_DAY, MS_PER_HOUR } from './units';

/**
 * Due times that passed while the rule could not run (the app was closed). Set: each runs over its own stretch, those
 * due within the last `backfillHours`; older ones are dropped. Unset: one run covers everything since the last.
 */
export interface MissedRuns {
  backfillHours?: number;
}
export type TimedTrigger =
  /** Each listed weekday (0 = Sunday) at local "HH:MM". */
  | ({ kind: 'daily'; at: string; days: number[] } & MissedRuns)
  /** Every `hours` hours, counted from where the rule's last scheduled window ended (or from when it was turned on). */
  | ({ kind: 'every'; hours: number } & MissedRuns)
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
/** Turning on "each missed time": a day away is caught up, and a longer absence costs no more runs than that. */
export const DEFAULT_BACKFILL_HOURS = 24;
const DAILY_AT = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAYS_PER_WEEK = 7;
/** Every weekday, Sunday first (Date.getDay order). */
export const ALL_DAYS: readonly number[] = Array.from({ length: DAYS_PER_WEEK }, (_, d) => d);
/** Run keys of timed runs start with this, so a rule's message runs never count as its last timed run. */
export const TIMED_RUN_PREFIX = 'time:';
/** Action-only timed runs append this marker and action id. Unmarked runs execute all rule actions. */
export const TIMED_RUN_ACTION_MARK = '#';
/** Catch-up action keys advance only that action. Rule schedules remain based on the latest scheduled run. */
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

const backfillError = (t: MissedRuns): string | null =>
  t.backfillHours === undefined || inHours(t.backfillHours) ? null : `Catch up missed times ${TIMED_HOURS_MIN} to ${TIMED_HOURS_MAX} hours back.`;

/** Why a timed trigger can't run as written, or null. */
export function timedTriggerError(t: TimedTrigger): string | null {
  switch (t.kind) {
    case 'daily':
      if (!DAILY_AT.test(t.at)) return 'Pick the time of day it runs.';
      return t.days.length && t.days.every((d) => Number.isInteger(d) && d >= 0 && d < DAYS_PER_WEEK)
        ? backfillError(t)
        : 'Pick the days it runs.';
    case 'every':
      return inHours(t.hours) ? backfillError(t) : `Run every ${TIMED_HOURS_MIN} to ${TIMED_HOURS_MAX} hours.`;
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
  /** Where this action's last timed window ended, or null. */
  lastRunAt: number | null;
  /** Where the rule's last scheduled window (of any of its actions; catch-ups excluded) ended, or null. */
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

/** A stretch a timed rule owes: the run's key (once per due time) and the span its actions read. */
export interface TimedWindow {
  key: string;
  sinceTs: number;
  untilTs: number;
}

/** The most windows one start can owe a trigger that runs each missed time: the due times its backfill reach can hold. 0 when merging. */
export function maxBackfillRuns(t: Exclude<TimedTrigger, { kind: 'appStart' }>): number {
  if (t.backfillHours === undefined) return 0;
  return Math.ceil((t.backfillHours * MS_PER_HOUR) / (t.kind === 'every' ? t.hours * MS_PER_HOUR : MS_PER_DAY));
}

/** The daily due times after `from`, up to `now`, oldest first. */
function dailyDuesSince(t: { at: string; days: readonly number[] }, from: number, now: number): number[] {
  const dues: number[] = [];
  for (let due = lastDailyDue(now, t.at, t.days); due > from; due = lastDailyDue(due - 1, t.at, t.days)) dues.unshift(due);
  return dues;
}

/** The due times `stepMs` apart counted from `scheduled`, after `from` and up to `now`, oldest first. */
function everyDuesSince(scheduled: number, stepMs: number, from: number, now: number): number[] {
  const dues: number[] = [];
  for (let due = scheduled + (Math.floor((from - scheduled) / stepMs) + 1) * stepMs; due <= now; due += stepMs) dues.push(due);
  return dues;
}

/**
 * What a timed rule owes now, oldest first; empty when nothing is due. Merging (no `backfillHours`), missed due times
 * are one window ending now. Otherwise each due time has its own window ending at it, so windows tile without overlap.
 */
export function dueWindows(t: TimedTrigger, s: TimedState): TimedWindow[] {
  const floor = s.now - TIMED_MAX_LOOKBACK_MS;
  const from = Math.max(s.lastRunAt ?? s.armedAt, s.armedAt);
  switch (t.kind) {
    case 'daily': {
      const key = (due: number): string => `${TIMED_RUN_PREFIX}daily:${due}`;
      if (t.backfillHours === undefined) {
        const due = lastDailyDue(s.now, t.at, t.days);
        return due > from ? [{ key: key(due), sinceTs: Math.max(from, floor), untilTs: s.now }] : [];
      }
      const reach = Math.max(from, s.now - t.backfillHours * MS_PER_HOUR);
      return dailyDuesSince(t, reach, s.now).map((due) => ({
        key: key(due),
        sinceTs: Math.max(from, lastDailyDue(due - 1, t.at, t.days)),
        untilTs: due,
      }));
    }
    case 'every': {
      const stepMs = t.hours * MS_PER_HOUR;
      const key = (due: number): string => `${TIMED_RUN_PREFIX}every:${due}`;
      const scheduled = Math.max(s.ruleRunAt ?? s.armedAt, s.armedAt);
      const each = t.backfillHours !== undefined;
      // Sat out the rule's last scheduled run: catches up to it (each) or to now (merging), then runs with the others.
      if (from < scheduled) return [{ key: `${TIMED_CATCH_UP_PREFIX}${scheduled}`, sinceTs: Math.max(from, floor), untilTs: each ? scheduled : s.now }];
      if (t.backfillHours === undefined) {
        const due = scheduled + stepMs;
        return due <= s.now ? [{ key: key(due), sinceTs: Math.max(from, floor), untilTs: s.now }] : [];
      }
      const reach = Math.max(from, s.now - t.backfillHours * MS_PER_HOUR);
      return everyDuesSince(scheduled, stepMs, reach, s.now).map((due) => ({ key: key(due), sinceTs: Math.max(from, due - stepMs), untilTs: due }));
    }
    case 'appStart': {
      // Turned on during this session: its first app start is the next one.
      if (s.appStartDone || s.armedAt > s.sessionStart) return [];
      if (s.owedSince === null && s.sessionStart - s.lastSeenAt < t.awayHours * MS_PER_HOUR) return [];
      const from = Math.max(s.owedSince ?? s.lastSeenAt, s.armedAt, floor);
      const sinceTs = Math.max(from, s.coveredFrom(from) ?? from);
      return sinceTs < s.now ? [{ key: `${TIMED_RUN_PREFIX}start:${s.sessionStart}`, sinceTs, untilTs: s.now }] : [];
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
    : t.backfillHours !== undefined
      ? 'The stretch before each due time'
      : 'Since its last run; at most a week';

/** Weekday labels in Date.getDay order. */
export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
