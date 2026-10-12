// Timed actions settle their claimed windows across failures and interrupted sessions.
import { describe, expect, it } from 'vitest';
import type { RuleAction } from '@shared/rules';
import {
  TIMED_ATTEMPTS_MAX, TIMED_MAX_LOOKBACK_MS, TIMED_RETRY_DELAYS_MS, timedRetryDelayMs, type TimedTrigger,
} from '@shared/ruleTime';
import { MS_PER_HOUR, MS_PER_MIN } from '@shared/units';
import { newRuleAction } from '@shared/ruleSpec';
import { RuleSchedule } from '../src/core/rules/schedule';
import { beginAttempt, claimTimedRun, forgiveDebts, oldestOwedRun, settleAttempt } from '../src/core/rules/runDebts';
import { releaseInterruptedTimedRuns } from '../src/core/rules/ruleStore';
import { probeAction, ruleHarness, ruleInput, type Harness } from './ruleHarness';

const at = (hours: number, minutes = 0) => new Date(2026, 8, 25, hours, minutes).getTime();
const windowAction = () => probeAction('window');
const command = () => ({ ...newRuleAction('command'), config: { pluginId: 'p', commandId: 'c', lookbackMs: MS_PER_HOUR } });
const windows = (h: Harness) => h.probe.runs.flatMap((r) => r.event.kind === 'window' ? [r.event] : []);
const spans = (h: Harness) => windows(h).map((w) => [w.range.sinceTs, w.range.untilTs]);
const failed = { outcome: 'failed', detail: 'provider down' } as const;
const done = { outcome: 'done', detail: null } as const;
const debtCount = (h: Harness) => (h.db.prepare('SELECT COUNT(*) AS n FROM rule_run_debts').get() as { n: number }).n;

function setup(trigger: TimedTrigger = { kind: 'every', hours: 24 }, actions: RuleAction[] = [windowAction()]) {
  let now = at(0);
  const h = ruleHarness(() => now);
  const input = ruleInput(actions, { trigger });
  const id = h.rules.create(input);
  return {
    ...h, id, input,
    setNow: (ts: number) => { now = ts; },
    session: (lastSeen = at(0)) => new RuleSchedule(h.db, h.engine, h.actions, lastSeen, (e) => h.events.push(e), () => now),
  };
}

describe('a timed run still owes each unsettled action', () => {
  it('allows one attempt and retries after a blip, a short outage and a long outage', () => {
    expect(TIMED_RETRY_DELAYS_MS).toEqual([5 * MS_PER_MIN, 30 * MS_PER_MIN, 2 * MS_PER_HOUR]);
    expect([1, 2, 3, 4, 5].map(timedRetryDelayMs)).toEqual([...TIMED_RETRY_DELAYS_MS, null, null]);
    expect(TIMED_ATTEMPTS_MAX).toBe(TIMED_RETRY_DELAYS_MS.length + 1);
  });

  it('retries the same window in the same run only after its delay, then clears its retry time', async () => {
    const h = setup();
    h.probe.context().rules.action('ruleprobe.window', (_, r) => {
      h.probe.runs.push(r);
      return h.probe.runs.length === 1 ? failed : done;
    });
    h.setNow(at(24));
    const schedule = h.session();
    await schedule.tick();
    const first = h.rules.runs(h.id, 10)[0]!;
    expect(first.actions[0]).toMatchObject({ outcome: 'failed', retryAt: at(24, 5) });
    h.setNow(at(24, 5) - 1);
    await schedule.tick();
    expect(windows(h)).toHaveLength(1);
    h.setNow(at(24, 5));
    await schedule.tick();
    expect(spans(h)).toEqual([[at(0), at(24)], [at(0), at(24)]]);
    expect(h.probe.runs.map((r) => r.runId)).toEqual([first.id, first.id]);
    expect(h.rules.runs(h.id, 10)).toHaveLength(1);
    expect(h.rules.runs(h.id, 1)[0]!.actions[0]).toMatchObject({ outcome: 'done', retryAt: null });
    expect(debtCount(h)).toBe(0);
  });

  it('counts attempts before running and waits from the failure time when an action takes a while', async () => {
    const h = setup();
    h.probe.context().rules.action('ruleprobe.window', (_, r) => {
      const debt = h.db.prepare('SELECT attempts, retry_at AS retryAt FROM rule_run_debts WHERE run_id = ?').get(r.runId!);
      expect(debt).toEqual({ attempts: 1, retryAt: at(24, 5) });
      h.setNow(at(24, 2));
      return failed;
    });
    h.setNow(at(24));
    await h.session().tick();
    expect(h.rules.runs(h.id, 1)[0]!.actions[0]!.retryAt).toBe(at(24, 7));
  });

  it('spends the retry ladder once per window and keeps the failed marker after the last attempt', async () => {
    const h = setup();
    h.probe.context().rules.action('ruleprobe.window', (_, r) => { h.probe.runs.push(r); return failed; });
    let now = at(24);
    h.setNow(now);
    const schedule = h.session();
    await schedule.tick();
    for (const delay of TIMED_RETRY_DELAYS_MS) {
      now += delay;
      h.setNow(now - 1);
      const count = windows(h).length;
      await schedule.tick();
      expect(windows(h)).toHaveLength(count);
      h.setNow(now);
      await schedule.tick();
    }
    const runId = h.probe.runs[0]!.runId;
    expect(windows(h).map((w) => w.retriesLeft)).toEqual([3, 2, 1, 0]);
    expect(h.rules.runs(h.id, 1)[0]!.actions[0]).toMatchObject({ outcome: 'failed', retryAt: null });
    expect(debtCount(h)).toBe(1);
    h.setNow(at(24) + 2 * TIMED_MAX_LOOKBACK_MS);
    await h.session().tick();
    expect(h.probe.runs.filter((r) => r.runId === runId)).toHaveLength(TIMED_ATTEMPTS_MAX);
  });

  it('runs later windows while a debt waits, then keeps the older retry quiet', async () => {
    const h = setup({ kind: 'every', hours: 1 });
    const a = windowAction();
    const runId = claimTimedRun(h.db, h.id, `time:every:${at(1)}`, at(1), { untilTs: at(1), timing: 'every' }, [{ actionId: a.id, sinceTs: at(0) }])!;
    for (let i = 0; i < 3; i++) beginAttempt(h.db, runId, a.id, at(1));
    settleAttempt(h.db, runId, a, failed, at(1), false);
    h.setNow(at(2));
    const schedule = h.session();
    await schedule.tick();
    expect(spans(h)).toEqual([[at(1), at(2)]]);
    h.setNow(at(3));
    await schedule.tick();
    expect(spans(h)).toEqual([[at(1), at(2)], [at(0), at(1)], [at(2), at(3)]]);
    expect(windows(h).map((w) => w.owedAfter)).toEqual([0, 2, 0]);
  });

  it('resumes only the unfinished action of a multi-action run, over its own stored window', async () => {
    const a = command(), b = windowAction();
    const h = setup({ kind: 'every', hours: 24 }, [a, b]);
    const runId = claimTimedRun(h.db, h.id, `time:every:${at(24)}`, at(24), { untilTs: at(24), timing: 'every' }, [
      { actionId: a.id, sinceTs: at(0) }, { actionId: b.id, sinceTs: at(2) },
    ])!;
    beginAttempt(h.db, runId, a.id, at(24));
    settleAttempt(h.db, runId, a, done, at(24), false);
    h.setNow(at(24, 1));
    await h.session(at(24)).tick();
    expect(h.ranges.commands).toEqual([]);
    expect(spans(h)).toEqual([[at(2), at(24)]]);
    expect(h.rules.runs(h.id, 10).map((r) => r.actions.map((x) => x.outcome))).toEqual([['done', 'done']]);
  });

  it.each([1, 9])('pays interrupted app-start work after %i hours away and keeps any new window separate', async (away) => {
    const h = setup({ kind: 'appStart', awayHours: 8 });
    const a = windowAction();
    const runId = claimTimedRun(h.db, h.id, `time:start:${at(8)}`, at(8), { untilTs: at(8), timing: 'appStart' }, [{ actionId: a.id, sinceTs: at(0) }])!;
    beginAttempt(h.db, runId, a.id, at(8));
    h.setNow(at(8 + away));
    const next = h.session(at(8));
    await next.tick();
    await next.tick();
    expect(spans(h)).toEqual(away < 8 ? [[at(0), at(8)]] : [[at(0), at(8)], [at(8), at(17)]]);
    expect(windows(h).map((w) => w.owedAfter)).toEqual(away < 8 ? [0] : [1, 0]);
    expect(h.probe.runs[0]!.runId).toBe(runId);
  });

  it('resumes an outcome-less attempt next session after its delay, never before it', async () => {
    const h = setup();
    const a = windowAction();
    const runId = claimTimedRun(h.db, h.id, `time:every:${at(24)}`, at(24), { untilTs: at(24), timing: 'every' }, [{ actionId: a.id, sinceTs: at(0) }])!;
    expect(beginAttempt(h.db, runId, a.id, at(24))).toBe(1);
    h.setNow(at(24, 4));
    const next = h.session(at(24));
    await next.tick();
    expect(windows(h)).toEqual([]);
    expect(h.rules.runs(h.id, 1)[0]!.id).toBe(runId);
    h.setNow(at(24, 5));
    await next.tick();
    expect(spans(h)).toEqual([[at(0), at(24)]]);
    expect(windows(h)[0]!.retriesLeft).toBe(2);
  });

  it('keeps an exhausted outcome-less attempt claimed across sessions', async () => {
    const h = setup();
    const a = windowAction();
    const runId = claimTimedRun(h.db, h.id, `time:every:${at(24)}`, at(24), { untilTs: at(24), timing: 'every' }, [{ actionId: a.id, sinceTs: at(0) }])!;
    for (let i = 0; i < TIMED_ATTEMPTS_MAX; i++) beginAttempt(h.db, runId, a.id, at(24));
    h.setNow(at(27));
    await h.session(at(24)).tick();
    expect(windows(h)).toEqual([]);
    expect(releaseInterruptedTimedRuns(h.db)).toBe(0);
    expect(debtCount(h)).toBe(1);
  });

  it('waits until every unspent debt of a run is ready, then pays all of them', async () => {
    const a = command(), b = windowAction();
    const h = setup({ kind: 'every', hours: 24 }, [a, b]);
    const runId = claimTimedRun(h.db, h.id, `time:every:${at(24)}`, at(24), { untilTs: at(24), timing: 'every' }, [
      { actionId: a.id, sinceTs: at(0) }, { actionId: b.id, sinceTs: at(1) },
    ])!;
    beginAttempt(h.db, runId, a.id, at(24));
    settleAttempt(h.db, runId, a, failed, at(24), false);
    expect(oldestOwedRun(h.db, h.id, at(24, 4))).toBeNull();
    h.setNow(at(24, 5));
    await h.session().tick();
    expect(h.ranges.commands.map((c) => [c.range.sinceTs, c.range.untilTs])).toEqual([[at(0), at(24)]]);
    expect(spans(h)).toEqual([[at(1), at(24)]]);
    expect(debtCount(h)).toBe(0);
  });

  it('drops expired windows and clamps remaining debt to the catch-up horizon', async () => {
    const h = setup();
    const a = windowAction();
    for (const hours of [24, 25]) claimTimedRun(h.db, h.id, `time:every:${at(hours)}`, at(hours), { untilTs: at(hours), timing: 'every' }, [{ actionId: a.id, sinceTs: at(0) }]);
    h.setNow(at(24) + TIMED_MAX_LOOKBACK_MS);
    await h.session().tick();
    expect(spans(h)[0]).toEqual([at(24), at(25)]);
    expect(spans(h).some(([, until]) => until === at(24))).toBe(false);
    expect(debtCount(h)).toBe(0);
  });

  it('forgives debts when the rule is re-armed or the action is removed', async () => {
    const a = command(), b = windowAction();
    const h = setup({ kind: 'every', hours: 24 }, [a, b]);
    claimTimedRun(h.db, h.id, `time:every:${at(24)}`, at(24), { untilTs: at(24), timing: 'every' }, [
      { actionId: a.id, sinceTs: at(0) }, { actionId: b.id, sinceTs: at(0) },
    ]);
    h.rules.update(h.id, { ...h.input, spec: { ...h.input.spec, actions: [a] } });
    h.setNow(at(24, 1));
    await h.session().tick();
    expect(windows(h)).toEqual([]);
    expect(debtCount(h)).toBe(0);
    claimTimedRun(h.db, h.id, `time:every:${at(48)}`, at(48), { untilTs: at(48), timing: 'every' }, [{ actionId: a.id, sinceTs: at(24) }]);
    const input = { ...h.input, spec: { ...h.input.spec, actions: [a] } };
    h.rules.update(h.id, { ...input, enabled: false });
    h.setNow(at(48, 1));
    h.rules.update(h.id, input);
    await h.session().tick();
    expect(h.ranges.commands).toHaveLength(1);
    expect(debtCount(h)).toBe(0);
  });

  it('settles an unavailable debt as sat out and hands app-start work to the existing catch-up', async () => {
    const h = setup({ kind: 'appStart', awayHours: 8 });
    const a = windowAction();
    claimTimedRun(h.db, h.id, `time:start:${at(8)}`, at(8), { untilTs: at(8), timing: 'appStart' }, [{ actionId: a.id, sinceTs: at(0) }]);
    await h.probe.host.setEnabled('ruleprobe', false);
    h.setNow(at(9));
    const next = h.session(at(8));
    await next.tick();
    expect(h.rules.runs(h.id, 1)[0]!.actions[0]).toMatchObject({ outcome: 'skipped', retryAt: null });
    expect(h.db.prepare('SELECT sat_out FROM rule_action_runs').pluck().get()).toBe(1);
    expect(debtCount(h)).toBe(0);
    await h.probe.host.setEnabled('ruleprobe', true);
    await next.tick();
    expect(spans(h)).toEqual([[at(0), at(9)]]);
  });

  describe('with an app-start window its plugin sat out at a later start', () => {
    /** An 08:00 app-start run failed and waits; the 20:00 start finds the plugin off, so it owes from 08:00 too. */
    async function satOutAfterDebt() {
      const h = setup({ kind: 'appStart', awayHours: 8 });
      const a = windowAction();
      const runId = claimTimedRun(h.db, h.id, `time:start:${at(8)}`, at(8), { untilTs: at(8), timing: 'appStart' }, [{ actionId: a.id, sinceTs: at(0) }])!;
      beginAttempt(h.db, runId, a.id, at(20));
      await h.probe.host.setEnabled('ruleprobe', false);
      h.setNow(at(20));
      await h.session(at(8)).tick();
      h.setNow(at(21));
      return h;
    }

    it('pays the debt and still runs the sat-out window, however short the next absence', async () => {
      const h = await satOutAfterDebt();
      await h.probe.host.setEnabled('ruleprobe', true);
      await h.session(at(20, 30)).tick();
      expect(spans(h)).toEqual([[at(0), at(8)], [at(8), at(21)]]);
    });

    it('widens the sat-out window to a debt the plugin sits out as well', async () => {
      const h = await satOutAfterDebt();
      const next = h.session(at(20, 30));
      await next.tick();
      await h.probe.host.setEnabled('ruleprobe', true);
      await next.tick();
      expect(spans(h)).toEqual([[at(0), at(21)]]);
    });
  });

  it('stops paying when the rule is deleted during an action, without claiming another window', async () => {
    const h = setup();
    const a = windowAction();
    claimTimedRun(h.db, h.id, `time:every:${at(24)}`, at(24), { untilTs: at(24), timing: 'every' }, [{ actionId: a.id, sinceTs: at(0) }]);
    h.probe.context().rules.action('ruleprobe.window', () => { h.rules.remove(h.id); return done; });
    h.setNow(at(48));
    await expect(h.session().tick()).resolves.toBeUndefined();
    expect(h.rules.runs(h.id, 10)).toEqual([]);
    expect(debtCount(h)).toBe(0);
  });

  it('claims debts atomically and reports a deleted run when settling', () => {
    const h = setup();
    const a = windowAction();
    const debt = { actionId: a.id, sinceTs: at(0) };
    const claim = (debts: typeof debt[]) => claimTimedRun(h.db, h.id, `time:every:${at(24)}`, at(24), { untilTs: at(24), timing: 'every' }, debts);
    expect(() => claim([debt, debt])).toThrow();
    expect(h.rules.runs(h.id, 10)).toEqual([]);
    const runId = claim([debt])!;
    expect(claim([debt])).toBeNull();
    forgiveDebts(h.db, h.id, at(0), []);
    expect(debtCount(h)).toBe(0);
    h.rules.remove(h.id);
    expect(beginAttempt(h.db, runId, a.id, at(24))).toBeNull();
    expect(() => settleAttempt(h.db, runId, a, done, at(24), false)).toThrow();
  });
});
