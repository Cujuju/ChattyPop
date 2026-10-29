// After archive catch-up, checks due timed rules every minute and executes actions over configured windows/channels.
import type { AppEvent } from '@shared/contract';
import { errorMessage } from '@shared/errors';
import { ruleKind } from '@shared/ruleKinds';
import { MS_PER_MIN } from '@shared/units';
import type { RuleAction } from '@shared/rules';
import { TIMED_ATTEMPTS_MAX, TIMED_MAX_LOOKBACK_MS, TIMED_RUN_ACTION_MARK } from '@shared/ruleTime';
import { getSetting, setSetting, type Db } from '../db';
import { inPlacesSql } from '../queries/channelScope';
import type { ActionResult, RuleActions } from './actions';
import type { CompiledRule } from './compile';
import type { RuleEngine } from './engine';
import type { WindowDue } from './kinds';
import { lastScheduledRun, lastTimedRun, releaseInterruptedTimedRuns } from './ruleStore';
import { beginAttempt, claimTimedRun, forgiveDebts, laterTimedRuns, oldestOwedRun, retryDebtNow, settleAttempt } from './runDebts';

/** How often due rules are checked; a daily rule starts within this of its time. */
const TICK_MS = MS_PER_MIN;
/** Persists owed app-start windows per rule/action and arming across quits. Executing actions clears debt; re-arming invalidates it. */
const OWED_APP_STARTS_KEY = 'rules.owedAppStarts';
type OwedAppStarts = Record<string, { sinceTs: number; armedAt: number }>;
/** An action's oldest owed window, and how many it owes after it. */
type OwedWindow = WindowDue & { owedAfter: number };
type ScheduledAction = { a: RuleAction; d: OwedWindow };
/** Actions execute in phase order, retaining declaration order within each phase. */
const phaseOrder = (actions: ScheduledAction[]): ScheduledAction[] => ['match', 'after'].flatMap((phase) =>
  actions.filter(({ a }) => (ruleKind('actions', a.type)?.phase ?? 'after') === phase),
);

/** Archived channels in a rule's Where: a channel covers its threads, a server its channels. null = every one. */
export function scopeChannels(db: Db, r: Pick<CompiledRule, 'spec'>): string[] | null {
  const places = inPlacesSql('id', r.spec.gates);
  if (!places) return null;
  return db.prepare(`SELECT id FROM channels WHERE opted_in = 1 AND ${places.sql}`).pluck().all(...places.params) as string[];
}

/** Claims due window rules and executes their actions in phase order. */
export class RuleSchedule {
  private started = false;
  private busy = false;
  /** Older builds' interrupted claims were released once, before this session claims any. */
  private releasedInterrupted = false;
  /** App-start rule actions (`<rule id>:<action id>`) already considered this session: each gets one chance per start. */
  private readonly appStartDone = new Set<string>();
  private readonly sessionStart: number;

  constructor(
    private readonly db: Db,
    private readonly engine: RuleEngine,
    private readonly actions: RuleActions,
    /** When the previous session was last seen. */
    private readonly lastSeenAt: number,
    private readonly emit: (e: AppEvent) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.sessionStart = now();
  }

  /** Sync drained its queue. The first call starts the schedule; later ones (reconnects) change nothing. */
  archiveCurrent(): void {
    if (this.started) return;
    this.started = true;
    void this.tick();
    setInterval(() => void this.tick(), TICK_MS);
  }

  /**
   * Retries a failed `type` action's window at the owner's request; false when its rule owes none. Pays debts only:
   * new windows wait for the archive to be current. Resolves once tried, or at once while a tick runs, which pays it.
   */
  async retry(type: string, runId: number, actionId: string): Promise<boolean> {
    if (!this.db.open) return false;
    const ruleId = retryDebtNow(this.db, type, runId, actionId, this.now());
    const r = this.engine.timedRules().find((x) => x.id === ruleId);
    const kind = r && this.engine.kinds.windows.get(r.spec.trigger.type);
    if (!r || !kind) return false;
    if (this.busy) return true;
    this.busy = true;
    try {
      const once = kind.oncePerSession(r.spec.trigger.config);
      for (let current = this.engine.find(r.id); current && this.db.open; current = this.engine.find(r.id)) {
        if (!(await this.payOldestDebt(current, this.now(), this.debtCutoff(current), scopeChannels(this.db, current), once))) break;
      }
      this.emit({ type: 'rules-changed' });
    } finally {
      this.busy = false;
    }
    return true;
  }

  /** Debts for windows ended by then are forgiven: a rule covers nothing before it was turned on, or over a week back. */
  private debtCutoff(r: CompiledRule): number {
    return Math.max(r.armedAt, this.now() - TIMED_MAX_LOOKBACK_MS);
  }

  /** Runs each due timed rule, one after another. */
  async tick(): Promise<void> {
    if (this.busy || !this.db.open) return; // the database closes while the archive is moved
    this.busy = true;
    try {
      if (!this.releasedInterrupted) {
        releaseInterruptedTimedRuns(this.db);
        this.releasedInterrupted = true;
      }
      const rules = this.engine.timedRules();
      this.forgetOwed((k) => !rules.some((r) => r.spec.actions.some((a) => k === `${r.id}:${a.id}`)));
      for (const r of rules) await this.runIfDue(r);
    } finally {
      this.busy = false;
    }
  }

  private owed(): OwedAppStarts {
    return (getSetting(this.db, OWED_APP_STARTS_KEY) as OwedAppStarts | undefined) ?? {};
  }

  /** Records an app-start window `considered` still owes, the widest per arming; written at once, so a quit keeps it. */
  private keepOwed(considered: string, sinceTs: number, armedAt: number): void {
    const owed = this.owed();
    const kept = owed[considered];
    if (kept?.armedAt === armedAt && kept.sinceTs <= sinceTs) return; // already owed from further back: the wider window stays
    setSetting(this.db, OWED_APP_STARTS_KEY, { ...owed, [considered]: { sinceTs, armedAt } });
  }

  private forgetOwed(drop: (considered: string) => boolean): void {
    const owed = this.owed();
    const kept = Object.fromEntries(Object.entries(owed).filter(([k]) => !drop(k)));
    if (Object.keys(kept).length !== Object.keys(owed).length) setSetting(this.db, OWED_APP_STARTS_KEY, kept);
  }

  /** Runs what a rule owes, oldest window first, until nothing is due: several when due times were missed. */
  private async runIfDue(r: CompiledRule): Promise<void> {
    const cutoff = this.debtCutoff(r);
    forgiveDebts(this.db, r.id, cutoff, r.spec.actions.map((a) => a.id));
    let ran = false;
    // Each pass reads claims, debts and the rule again: an interrupted action keeps its window; a rule deleted or turned off stops.
    for (let current = this.engine.find(r.id); current && this.db.open; current = this.engine.find(r.id)) {
      if (!(await this.runOldestDue(current, this.debtCutoff(current)))) break;
      ran = true;
    }
    if (ran) this.emit({ type: 'rules-changed' });
  }

  /** Windows this action has due now, based on claims and sat-out app-start work. */
  private dueNow(r: CompiledRule, a: RuleAction, now: number, channelIds: string[] | null): WindowDue[] {
    const t = r.spec.trigger;
    const o = this.owed()[`${r.id}:${a.id}`];
    return this.engine.kinds.windows.get(t.type)!.due(t.config, {
      now,
      armedAt: r.armedAt,
      lastRunAt: lastTimedRun(this.db, r.id, a.id),
      ruleRunAt: lastScheduledRun(this.db, r.id),
      sessionStart: this.sessionStart,
      lastSeenAt: this.lastSeenAt,
      appStartDone: this.appStartDone.has(`${r.id}:${a.id}`),
      owedSince: o?.armedAt === r.armedAt ? o.sinceTs : null,
      coveredFrom: (sinceTs) => this.engine.kinds.windows.covered({ sinceTs, channelIds }),
    });
  }

  /** Pays ready debts before new windows; waiting debts leave the schedule free to claim later windows. */
  private async runOldestDue(r: CompiledRule, cutoff: number): Promise<boolean> {
    const t = r.spec.trigger;
    const kind = this.engine.kinds.windows.get(t.type);
    if (!kind) return false;
    const now = this.now();
    const channelIds = scopeChannels(this.db, r);
    const once = kind.oncePerSession(t.config);
    const paid = await this.payOldestDebt(r, now, cutoff, channelIds, once);
    if (paid !== null) return paid;
    const owed = this.owed();
    const due = r.spec.actions.flatMap((a) => {
      const considered = `${r.id}:${a.id}`;
      const unavailable = this.engine.kinds.unavailable('actions', a.type);
      if (unavailable && !once) return [];
      const windows = this.dueNow(r, a, now, channelIds);
      const d = windows[0] ? { ...windows[0], owedAfter: windows.length - 1 } : null;
      if (unavailable) {
        if (d) this.keepOwed(considered, d.sinceTs, r.armedAt);
        return [];
      }
      if (once) {
        this.appStartDone.add(considered);
        if (!d && owed[considered]) this.forgetOwed((k) => k === considered);
      }
      return d ? [{ a, d }] : [];
    });
    const ordered = phaseOrder(due);
    const key = ordered[0]?.d.key;
    const whole = ordered.length === r.spec.actions.length && ordered.every(({ d }) => d.key === key);
    const runs = whole ? [{ key: key!, actions: ordered }] : ordered.map((x) => ({ key: `${x.d.key}${TIMED_RUN_ACTION_MARK}${x.a.id}`, actions: [x] }));
    let ran = false;
    for (const run of runs) ran = (await this.execute(r, run.key, run.actions, now, channelIds, once)) || ran;
    return ran;
  }

  /** Resumes unsettled actions in phase order; null when no debt is payable, false when the rule was deleted. */
  private async payOldestDebt(r: CompiledRule, now: number, cutoff: number, channelIds: string[] | null, once: boolean): Promise<boolean | null> {
    const run = oldestOwedRun(this.db, r.id, now);
    if (!run) return null;
    const actions = r.spec.actions.flatMap((a) => {
      const debt = run.debts.find((d) => d.actionId === a.id);
      return debt ? [{ a, d: {
        key: run.key, sinceTs: Math.max(debt.sinceTs, cutoff), untilTs: run.untilTs, timing: run.timing,
        owedAfter: laterTimedRuns(this.db, r.id, a.id, run.untilTs) + this.dueNow(r, a, now, channelIds).length,
      } }] : [];
    });
    // Nothing to run would leave the run payable, and the drain looping on it.
    return actions.length ? this.runActions(r, run.runId, phaseOrder(actions), channelIds, once) : null;
  }

  /** Claims runs before ordered per-action windows. Deleted/already-claimed rules return false; newly disabled actions retain their owed windows. */
  private async execute(
    r: CompiledRule,
    key: string,
    actions: ScheduledAction[],
    now: number,
    channelIds: string[] | null,
    once: boolean,
  ): Promise<boolean> {
    // The claim and each action's debt persist before any action begins.
    const runId = claimTimedRun(this.db, r.id, key, now, actions[0]!.d, actions.map(({ a, d }) => ({ actionId: a.id, sinceTs: d.sinceTs })));
    if (runId === null) return false;
    // The claim covers what these actions' plugins sat out; a paid debt covers its own window only.
    this.forgetOwed((k) => actions.some(({ a }) => k === `${r.id}:${a.id}`));
    return this.runActions(r, runId, actions, channelIds, once);
  }

  /** Begins attempts before invoking actions and settles each outcome, retaining failures for bounded retries. */
  private async runActions(r: CompiledRule, runId: number, actions: ScheduledAction[], channelIds: string[] | null, once: boolean): Promise<boolean> {
    for (const { a: planned, d } of actions) {
      // Each action starts from its rule as it is now: deleted or off stops the run; a dropped action's debt is forgiven next pass.
      const rule = this.engine.find(r.id);
      if (!rule) return false;
      const a = rule.spec.actions.find((x) => x.id === planned.id);
      if (!a) continue;
      const unavailable = this.engine.kinds.unavailable('actions', a.type);
      if (unavailable && once) {
        const considered = `${rule.id}:${a.id}`;
        this.appStartDone.delete(considered);
        this.keepOwed(considered, d.sinceTs, rule.armedAt);
      }
      const attempt = unavailable ? 0 : beginAttempt(this.db, runId, a.id, this.now());
      if (attempt === null) return false; // the rule was deleted meanwhile
      const event = {
        kind: 'window' as const, range: { sinceTs: d.sinceTs, untilTs: d.untilTs, channelIds },
        timing: d.timing, owedAfter: d.owedAfter, retriesLeft: TIMED_ATTEMPTS_MAX - attempt,
      };
      let result: ActionResult;
      try {
        result = unavailable ? { outcome: 'skipped', detail: unavailable } : await this.actions.run(a, { rule, runId, history: false, actionId: a.id, event });
      } catch (err) {
        result = { outcome: 'failed', detail: errorMessage(err) };
      }
      try {
        settleAttempt(this.db, runId, a, result, this.now(), unavailable !== null);
      } catch {
        return false; // the rule was deleted meanwhile (its runs went with it)
      }
    }
    return true;
  }
}
