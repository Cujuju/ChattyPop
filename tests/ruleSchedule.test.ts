// Contract tests for rule schedule.
import { afterEach, describe, expect, it } from 'vitest';
import { AFTER_MESSAGE, defineRuleAction, definePlugin } from '@plugin-sdk/shared';
import { BUNDLED_PLUGINS } from '@shared/bundledPlugins';
import type { PluginDescriptor } from '@shared/bundledTypes';
import { newRuleAction, validateRuleInput } from '@shared/ruleSpec';
import { TIMED_MAX_LOOKBACK_MS, dueWindows, lastDailyDue, maxBackfillRuns, type TimedState, type TimedTrigger } from '@shared/ruleTime';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MIN } from '@shared/units';
import { claimRun } from '../src/core/rules/ruleStore';
import { RuleSchedule } from '../src/core/rules/schedule';
import { probeAction, ruleHarness, ruleInput, type Harness } from './ruleHarness';

/** The probe plugin's id: its window action is the plugin action a test turns off. */
const PROBE = 'ruleprobe';
/** The probe's action that acts on a window; recorded in `h.probe.runs`. */
const windowAction = () => probeAction('window');
/** The host's plugin-command action, which also acts on windows; recorded in `h.ranges.commands`. */
const command = () => ({ ...newRuleAction('command'), config: { pluginId: 'p', commandId: 'c', lookbackMs: MS_PER_HOUR } });
/** The probe window action's windows, oldest first. */
const windows = (h: Harness) => h.probe.runs.flatMap((r) => (r.event.kind === 'window' ? [r.event] : []));
const spans = (h: Harness) => windows(h).map((w) => [w.range.sinceTs, w.range.untilTs]);
const off = (h: Harness) => h.probe.host.setEnabled(PROBE, false);
const on = (h: Harness) => h.probe.host.setEnabled(PROBE, true);

/** A plugin whose window action declares an hourly floor, as long as an hourly rule's interval. */
const FLOOR_ACTION = 'floorprobe.range';
const floorProbe = definePlugin({
  manifest: { id: 'floorprobe', name: 'Floor probe', version: '1', description: '' },
  rules: {
    actions: [
      defineRuleAction({
        ...AFTER_MESSAGE,
        type: FLOOR_ACTION,
        label: 'Floor probe',
        hint: '',
        targets: ['window'],
        minIntervalMs: MS_PER_HOUR,
        create: () => null,
        validate() {},
      }),
    ],
  },
});

const restore: (() => void)[] = [];
afterEach(() => restore.splice(0).forEach((f) => f()));

/** Local times on Friday 25 Sep 2026. */
const at = (h: number, m = 0, day = 25): number => new Date(2026, 8, day, h, m).getTime();
/** Unless `o` says otherwise, the action's last run was the rule's last scheduled run. */
const state = (o: Partial<TimedState>): TimedState => ({
  now: at(9),
  armedAt: at(0) - 30 * MS_PER_DAY,
  lastRunAt: null,
  ruleRunAt: o.lastRunAt ?? null,
  sessionStart: at(9),
  lastSeenAt: at(8, 59),
  appStartDone: false,
  owedSince: null,
  coveredFrom: () => null,
  ...o,
});

describe('when a timed rule is due', () => {
  it('runs daily once its time passes, from its last run, at most a week back, on its days only', () => {
    const daily: TimedTrigger = { kind: 'daily', at: '08:00', days: [0, 1, 2, 3, 4, 5, 6] };
    expect(dueWindows(daily, state({ now: at(7), lastRunAt: at(8) - MS_PER_DAY }))).toEqual([]);
    expect(dueWindows(daily, state({ lastRunAt: at(8, 1) - MS_PER_DAY }))).toEqual([
      { key: `time:daily:${at(8)}`, sinceTs: at(8, 1) - MS_PER_DAY, untilTs: at(9) },
    ]);
    expect(dueWindows(daily, state({ lastRunAt: null }))[0]!.sinceTs).toBe(at(9) - TIMED_MAX_LOOKBACK_MS);
    // Turned on after today's time: that one counts as done.
    expect(dueWindows(daily, state({ armedAt: at(8, 30) }))).toEqual([]);
    // Saturdays only, on a Friday: last Saturday's.
    expect(lastDailyDue(at(9), '08:00', [6])).toBe(at(8, 0, 19));
  });

  it('runs every N hours from the last run, or from being turned on', () => {
    const every: TimedTrigger = { kind: 'every', hours: 6 };
    expect(dueWindows(every, state({ armedAt: at(4) }))).toEqual([]);
    expect(dueWindows(every, state({ armedAt: at(3) }))).toEqual([{ key: `time:every:${at(9)}`, sinceTs: at(3), untilTs: at(9) }]);
    expect(dueWindows(every, state({ armedAt: at(0), lastRunAt: at(5) }))).toEqual([]);
    // Sat out the rule's 05:00 run: catches up now, then is due with the rest at 11:00.
    expect(dueWindows(every, state({ armedAt: at(0), lastRunAt: null, ruleRunAt: at(5) }))).toEqual([
      { key: `time:catchUp:${at(5)}`, sinceTs: at(0), untilTs: at(9) },
    ]);
    expect(dueWindows(every, state({ armedAt: at(0), lastRunAt: at(6), ruleRunAt: at(5), now: at(11) }))).toEqual([
      { key: `time:every:${at(11)}`, sinceTs: at(6), untilTs: at(11) },
    ]);
  });

  it('merges due times missed while closed into one window ending now', () => {
    const every: TimedTrigger = { kind: 'every', hours: 3 };
    // Last ran 22:00 yesterday; opened 12 hours and a quarter later.
    expect(dueWindows(every, state({ now: at(10, 15), lastRunAt: at(22, 0, 24) }))).toEqual([
      { key: `time:every:${at(1)}`, sinceTs: at(22, 0, 24), untilTs: at(10, 15) },
    ]);
  });

  it('owes each missed due time its own window, tiling from the last one to the newest due time', () => {
    const every: TimedTrigger = { kind: 'every', hours: 3, backfillHours: 24 };
    const closed = state({ now: at(10, 15), lastRunAt: at(22, 0, 24) });
    expect(dueWindows(every, closed)).toEqual([
      { key: `time:every:${at(1)}`, sinceTs: at(22, 0, 24), untilTs: at(1) },
      { key: `time:every:${at(4)}`, sinceTs: at(1), untilTs: at(4) },
      { key: `time:every:${at(7)}`, sinceTs: at(4), untilTs: at(7) },
      { key: `time:every:${at(10)}`, sinceTs: at(7), untilTs: at(10) },
    ]);
    // On time, the one window ends at its due time, not when the tick reached it: the schedule never drifts.
    expect(dueWindows(every, state({ now: at(13, 1), lastRunAt: at(10) }))).toEqual([{ key: `time:every:${at(13)}`, sinceTs: at(10), untilTs: at(13) }]);
    expect(dueWindows(every, state({ now: at(12, 59), lastRunAt: at(10) }))).toEqual([]);
  });

  it('drops missed due times older than the backfill reach, keeping the due-time grid', () => {
    const every: TimedTrigger = { kind: 'every', hours: 3, backfillHours: 6 };
    // Due 01:00, 04:00, 07:00 and 10:00; only those within six hours of 10:15 run, each over its own three hours.
    expect(dueWindows(every, state({ now: at(10, 15), lastRunAt: at(22, 0, 24) })).map((w) => [w.sinceTs, w.untilTs])).toEqual([
      [at(4), at(7)],
      [at(7), at(10)],
    ]);
    // A month away at the widest reach: a week of due times, no more.
    const far = dueWindows({ kind: 'every', hours: 24, backfillHours: 168 }, state({ now: at(9), lastRunAt: at(9) - 30 * MS_PER_DAY }));
    expect(far.map((w) => w.untilTs)).toEqual([6, 5, 4, 3, 2, 1, 0].map((days) => at(9) - days * MS_PER_DAY));
  });

  it('says the most runs one start can owe, from how far back missed times run', () => {
    expect(maxBackfillRuns({ kind: 'every', hours: 3 })).toBe(0);
    expect(maxBackfillRuns({ kind: 'every', hours: 3, backfillHours: 24 })).toBe(8);
    expect(maxBackfillRuns({ kind: 'every', hours: 3, backfillHours: 2 })).toBe(1);
    expect(maxBackfillRuns({ kind: 'daily', at: '08:00', days: [1], backfillHours: 72 })).toBe(3);
    // The reach holds no more due times than it says: 01:00 to 22:00 is eight, three hours apart.
    const every: TimedTrigger = { kind: 'every', hours: 3, backfillHours: 24 };
    expect(dueWindows(every, state({ now: at(22), lastRunAt: at(22) - 3 * MS_PER_DAY }))).toHaveLength(8);
  });

  it('owes each missed daily time its own day, on its days only', () => {
    const daily: TimedTrigger = { kind: 'daily', at: '08:00', days: [0, 1, 2, 3, 4, 5, 6], backfillHours: 72 };
    // Last ran Tuesday 22 Sep 08:00; opened Friday 09:00.
    expect(dueWindows(daily, state({ lastRunAt: at(8, 0, 22) }))).toEqual([
      { key: `time:daily:${at(8, 0, 23)}`, sinceTs: at(8, 0, 22), untilTs: at(8, 0, 23) },
      { key: `time:daily:${at(8, 0, 24)}`, sinceTs: at(8, 0, 23), untilTs: at(8, 0, 24) },
      { key: `time:daily:${at(8)}`, sinceTs: at(8, 0, 24), untilTs: at(8) },
    ]);
    // Wednesdays and Fridays only: Thursday owes nothing, and Friday's window reaches back to Wednesday's.
    expect(dueWindows({ ...daily, days: [3, 5] }, state({ lastRunAt: at(8, 0, 22) })).map((w) => [w.sinceTs, w.untilTs])).toEqual([
      [at(8, 0, 22), at(8, 0, 23)],
      [at(8, 0, 23), at(8)],
    ]);
  });

  it('catches an action that sat out up to the last due time, so it rejoins the grid', () => {
    const every: TimedTrigger = { kind: 'every', hours: 6, backfillHours: 24 };
    expect(dueWindows(every, state({ armedAt: at(0), lastRunAt: null, ruleRunAt: at(6) }))).toEqual([
      { key: `time:catchUp:${at(6)}`, sinceTs: at(0), untilTs: at(6) },
    ]);
  });

  it('refuses a backfill reach outside the hours a timed rule takes', () => {
    expect(() => validateRuleInput(ruleInput([windowAction()], { trigger: { kind: 'every', hours: 3, backfillHours: 24 } }))).not.toThrow();
    expect(() => validateRuleInput(ruleInput([windowAction()], { trigger: { kind: 'every', hours: 3, backfillHours: 0 } }))).toThrow(/1 to 168 hours back/);
    expect(() =>
      validateRuleInput(ruleInput([windowAction()], { trigger: { kind: 'daily', at: '08:00', days: [1], backfillHours: 200 } })),
    ).toThrow(/1 to 168 hours back/);
  });

  it('catches up once per start after a long enough absence, after what a summary already covers', () => {
    const start: TimedTrigger = { kind: 'appStart', awayHours: 8 };
    const away = { lastSeenAt: at(0) };
    expect(dueWindows(start, state(away))).toEqual([{ key: `time:start:${at(9)}`, sinceTs: at(0), untilTs: at(9) }]);
    expect(dueWindows(start, state({ lastSeenAt: at(3) }))).toEqual([]);
    expect(dueWindows(start, state({ ...away, appStartDone: true }))).toEqual([]);
    expect(dueWindows(start, state({ ...away, armedAt: at(9, 1), now: at(9, 5) }))).toEqual([]); // turned on this session
    expect(dueWindows(start, state({ ...away, coveredFrom: () => at(6) }))[0]!.sinceTs).toBe(at(6));
    expect(dueWindows(start, state({ ...away, coveredFrom: () => at(9) }))).toEqual([]);
    // Owed from an earlier start: due however short this absence, from where that window began.
    expect(dueWindows(start, state({ lastSeenAt: at(3), owedSince: at(1) }))).toEqual([{ key: `time:start:${at(9)}`, sinceTs: at(1), untilTs: at(9) }]);
  });
});

describe('timed rules', () => {
  it('act on a stretch of time only: no message actions, matches or people', () => {
    const daily: TimedTrigger = { kind: 'daily', at: '08:00', days: [0, 1, 2, 3, 4, 5, 6] };
    expect(() => validateRuleInput(ruleInput([command(), windowAction()], { trigger: daily }))).not.toThrow();
    expect(() => validateRuleInput(ruleInput([probeAction()], { trigger: daily }))).toThrow(
      /can only run a plugin command or probe/,
    );
    expect(() =>
      validateRuleInput(
        ruleInput([windowAction()], {
          trigger: daily,
          match: { text: { pattern: 'x', spec: null } },
        }),
      ),
    ).toThrow(/clear what it matches/);
    expect(() =>
      validateRuleInput(
        ruleInput([windowAction()], {
          trigger: { kind: 'daily', at: '25:00', days: [0, 1, 2, 3, 4, 5, 6] },
        }),
      ),
    ).toThrow(/time of day/);
    expect(() =>
      validateRuleInput(ruleInput([windowAction()], { trigger: { kind: 'every', hours: 0 } })),
    ).toThrow(/every 1 to 168/);
  });

  it('run once per due time over their Where, labelled by trigger, and record a failed action', async () => {
    let now = at(8, 30);
    const h = ruleHarness(() => now);
    const id = h.rules.create(
      ruleInput([windowAction(), command()], {
        trigger: { kind: 'daily', at: '09:00', days: [0, 1, 2, 3, 4, 5, 6] },
        gates: { channelIds: ['c1'] },
      }),
    );
    const schedule = new RuleSchedule(
      h.db,
      h.engine,
      h.actions,
      now - MS_PER_HOUR,
      (e) => h.events.push(e),
      () => now,
    );
    await schedule.tick();
    expect(windows(h)).toEqual([]); // turned on after yesterday's 09:00: nothing due before today's
    now = at(9, 1);
    await schedule.tick();
    await schedule.tick();
    const due = { sinceTs: at(8, 30), untilTs: at(9, 1), channelIds: ['c1'] };
    expect(windows(h).map((w) => [w.range, w.timing])).toEqual([[due, 'daily']]);
    expect(h.ranges.commands.map((c) => c.range)).toEqual([due]);
    expect(h.rules.runs(id, 10).map((r) => [r.messageId, r.actions.map((a) => a.outcome)])).toEqual([[null, ['done', 'done']]]);

    h.ranges.answer = () => Promise.reject(new Error('provider down'));
    now = at(9, 1, 26);
    await schedule.tick();
    expect(h.rules.runs(id, 1)[0]!.actions.map((a) => [a.outcome, a.detail])).toEqual([
      ['done', 'window'],
      ['failed', 'provider down'],
    ]);
  });

  it("aren't held to the message runs' floor: an hourly rule runs each hour though its last run took a while", async () => {
    // The retention floor exceeds the second hourly run’s time.
    const list = BUNDLED_PLUGINS as PluginDescriptor[];
    list.push(floorProbe);
    restore.push(() => void list.splice(list.indexOf(floorProbe), 1));
    let now = at(8);
    const h = ruleHarness(() => now);
    const since: number[] = [];
    h.engine.kinds.action(FLOOR_ACTION, async (_, r) => {
      if (r.event.kind === 'window') since.push(r.event.range.sinceTs);
      now += 2 * MS_PER_MIN; // the action takes two minutes, so it finishes after the run was claimed
      return { outcome: 'done', detail: null };
    });
    h.rules.create(ruleInput([{ id: 'range', type: FLOOR_ACTION, config: null }], { trigger: { kind: 'every', hours: 1 } }));
    const schedule = new RuleSchedule(
      h.db,
      h.engine,
      h.actions,
      now,
      () => {},
      () => now,
    );
    now = at(9);
    await schedule.tick();
    now = at(10);
    await schedule.tick();
    expect(since).toEqual([at(8), at(9)]);
  });
});

describe("a timed rule whose action's plugin is off", () => {
  it('keeps an app-start window owed and runs it once the plugin is back that session', async () => {
    let now = at(0) - MS_PER_HOUR;
    const h = ruleHarness(() => now);
    h.rules.create(ruleInput([windowAction()], { trigger: { kind: 'appStart', awayHours: 8 } }));
    now = at(8);
    const schedule = new RuleSchedule(h.db, h.engine, h.actions, at(0), () => {}, () => now);
    await off(h);
    await schedule.tick();
    now = at(9);
    await on(h);
    await schedule.tick();
    await schedule.tick();
    expect(spans(h)).toEqual([[at(0), at(9)]]);
  });

  it('carries an app-start window it still owes at quit over to the next start, however short that absence', async () => {
    let now = at(0) - MS_PER_HOUR;
    const h = ruleHarness(() => now);
    h.rules.create(ruleInput([windowAction()], { trigger: { kind: 'appStart', awayHours: 8 } }));
    now = at(8);
    await off(h);
    await new RuleSchedule(h.db, h.engine, h.actions, at(0), () => {}, () => now).tick();
    // Quits at 09:00 with the plugin disabled; resumes at 10:00.
    now = at(10);
    await on(h);
    const next = new RuleSchedule(h.db, h.engine, h.actions, at(9), () => {}, () => now);
    await next.tick();
    await next.tick();
    expect(spans(h)).toEqual([[at(0), at(10)]]);
    // Settled: the start after that owes nothing.
    now = at(11);
    await new RuleSchedule(h.db, h.engine, h.actions, at(10, 30), () => {}, () => now).tick();
    expect(windows(h)).toHaveLength(1);
  });

  it('runs its other actions on time, the deferred one from where it left off, then all on the shared schedule', async () => {
    let now = at(0);
    const h = ruleHarness(() => now);
    const id = h.rules.create(ruleInput([windowAction(), command()], { trigger: { kind: 'every', hours: 6 } }));
    const schedule = new RuleSchedule(h.db, h.engine, h.actions, now, () => {}, () => now);
    const both = () => ({
      windows: spans(h),
      commands: h.ranges.commands.map((c) => [c.range.sinceTs, c.range.untilTs]),
    });
    await off(h);
    now = at(6);
    await schedule.tick();
    expect(both()).toEqual({ windows: [], commands: [[at(0), at(6)]] });
    now = at(7);
    await on(h);
    await schedule.tick();
    expect(both()).toEqual({ windows: [[at(0), at(7)]], commands: [[at(0), at(6)]] });
    now = at(12);
    await schedule.tick();
    now = at(13);
    await schedule.tick();
    // Realigned: both run at 12:00 in one run of the rule, each from its own last run.
    expect(both()).toEqual({ windows: [[at(0), at(7)], [at(7), at(12)]], commands: [[at(0), at(6)], [at(6), at(12)]] });
    expect(h.rules.runs(id, 10).map((r) => r.actions.length)).toEqual([2, 1, 1]);
    now = at(18);
    await schedule.tick();
    expect(both().windows.at(-1)).toEqual([at(12), at(18)]);
    expect(both().commands.at(-1)).toEqual([at(12), at(18)]);
  });
});

describe('a timed rule whose action’s plugin turns off while an earlier action runs', () => {
  it('keeps that action’s window, and catches it up once the plugin is back', async () => {
    let now = at(0);
    const h = ruleHarness(() => now);
    const id = h.rules.create(ruleInput([command(), windowAction()], { trigger: { kind: 'every', hours: 6 } }));
    const schedule = new RuleSchedule(h.db, h.engine, h.actions, now, () => {}, () => now);
    h.ranges.answer = async () => (await off(h), 'answered');
    now = at(6);
    await schedule.tick();
    expect(windows(h)).toEqual([]);
    expect(h.rules.runs(id, 10).map((r) => r.actions.map((a) => a.outcome))).toEqual([['done', 'skipped']]);
    h.ranges.answer = async () => 'answered';
    now = at(7);
    await on(h);
    await schedule.tick();
    expect(spans(h)).toEqual([[at(0), at(7)]]);
  });

  it('keeps an app-start window owed, and runs it once the plugin is back that session', async () => {
    let now = at(0) - MS_PER_HOUR;
    const h = ruleHarness(() => now);
    h.rules.create(ruleInput([command(), windowAction()], { trigger: { kind: 'appStart', awayHours: 8 } }));
    now = at(8);
    const schedule = new RuleSchedule(h.db, h.engine, h.actions, at(0), () => {}, () => now);
    h.ranges.answer = async () => (await off(h), 'answered');
    await schedule.tick();
    expect(windows(h)).toEqual([]);
    h.ranges.answer = async () => 'answered';
    now = at(9);
    await on(h);
    await schedule.tick();
    await schedule.tick();
    expect(spans(h)).toEqual([[at(0), at(9)]]);
  });
});

describe('a timed rule set to run each missed time', () => {
  const every3 = { kind: 'every', hours: 3, backfillHours: 24 } as const;
  /** When a run stored by an earlier build ran: some seconds after its due time. */
  const LEGACY_RAN_LATE_MS = 40_000;
  /** A session's schedule over `h`, as an app start makes it. */
  const session = (h: Harness, now: () => number, lastSeenAt: number) => new RuleSchedule(h.db, h.engine, h.actions, lastSeenAt, (e) => h.events.push(e), now);
  const commandSpans = (h: Harness) => h.ranges.commands.map((c) => [c.range.sinceTs, c.range.untilTs]);

  it('runs one window per due time missed while closed, oldest first, then stays on the grid', async () => {
    let now = at(22, 0, 24);
    const h = ruleHarness(() => now);
    const id = h.rules.create(ruleInput([windowAction(), command()], { trigger: every3, gates: { channelIds: ['c1'] } }));
    // Closed from 22:00 until 10:15 the next morning.
    now = at(10, 15);
    const schedule = session(h, () => now, at(22, 0, 24));
    await schedule.tick();
    const missed = [[at(22, 0, 24), at(1)], [at(1), at(4)], [at(4), at(7)], [at(7), at(10)]];
    expect(spans(h)).toEqual(missed);
    expect(commandSpans(h)).toEqual(missed);
    // Each says how many it still owes, so an action can stay quiet until the newest.
    expect(windows(h).map((w) => w.owedAfter)).toEqual([3, 2, 1, 0]);
    expect(h.rules.runs(id, 10).map((r) => r.actions.map((a) => a.outcome))).toEqual(Array(4).fill(['done', 'done']));
    await schedule.tick();
    expect(windows(h)).toHaveLength(4);
    // The next due time is 13:00, three hours after the last due time, not after the app opened.
    now = at(12, 59);
    await schedule.tick();
    expect(windows(h)).toHaveLength(4);
    now = at(13, 1);
    await schedule.tick();
    expect(spans(h).at(-1)).toEqual([at(10), at(13)]);
  });

  it('releases an older build’s outcome-less claim and reruns its interrupted window', async () => {
    let now = at(22, 0, 24);
    const h = ruleHarness(() => now);
    const id = h.rules.create(ruleInput([command()], { trigger: every3 }));
    // Opened at 01:05: the 01:00 window runs. At 04:01 the 04:00 window is claimed, and the app quits while its action runs.
    now = at(1, 5);
    await session(h, () => now, at(22, 0, 24)).tick();
    claimRun(h.db, id, `time:every:${at(4)}`, null, true, at(4, 1), at(4));
    expect(h.rules.runs(id, 10).map((r) => r.actions.length).sort()).toEqual([0, 1]);

    now = at(10, 30);
    await session(h, () => now, at(4, 1)).tick();
    expect(commandSpans(h)).toEqual([[at(22, 0, 24), at(1)], [at(1), at(4)], [at(4), at(7)], [at(7), at(10)]]);
    expect(h.rules.runs(id, 10).map((r) => r.actions.map((a) => a.outcome))).toEqual(Array(4).fill(['done']));
  });

  it('keeps a failed window claimed for retry while later windows still run', async () => {
    let now = at(22, 0, 24);
    const h = ruleHarness(() => now);
    const id = h.rules.create(ruleInput([command()], { trigger: every3 }));
    now = at(4, 30);
    h.ranges.answer = () => (h.ranges.commands.length === 1 ? Promise.reject(new Error('provider down')) : Promise.resolve('answered'));
    const schedule = session(h, () => now, at(22, 0, 24));
    await schedule.tick();
    await schedule.tick();
    expect(commandSpans(h)).toEqual([[at(22, 0, 24), at(1)], [at(1), at(4)]]);
    expect(h.rules.runs(id, 10).map((r) => r.actions.map((a) => a.outcome)).sort()).toEqual([['done'], ['failed']]);
    now = at(4, 35);
    await schedule.tick();
    expect(commandSpans(h)).toEqual([[at(22, 0, 24), at(1)], [at(1), at(4)], [at(22, 0, 24), at(1)]]);
    expect(h.rules.runs(id, 10).map((r) => r.actions.map((a) => a.outcome))).toEqual([['done'], ['done']]);
  });

  it('counts a run stored before window ends were kept as ending when it ran', async () => {
    let now = at(22, 0, 24);
    const h = ruleHarness(() => now);
    const id = h.rules.create(ruleInput([command()], { trigger: every3 }));
    const ranAt = at(1) + LEGACY_RAN_LATE_MS;
    const runId = claimRun(h.db, id, `time:every:${at(1)}`, null, true, ranAt)!;
    h.db.prepare("INSERT INTO rule_action_runs (run_id, action_id, kind, outcome, at) VALUES (?, 'legacy', 'command', 'done', ?)").run(runId, ranAt);
    now = at(4, 5);
    await session(h, () => now, at(1, 30)).tick();
    expect(commandSpans(h)).toEqual([[ranAt, ranAt + 3 * MS_PER_HOUR]]);
  });
});
