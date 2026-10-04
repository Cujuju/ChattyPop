// Timed rules: once the archive is current (so nothing that arrived while ChattyPop was closed is missed), checks
// each minute for timed rules that are due and runs their actions over the rule's window and channels.
import type { AppEvent } from '@shared/contract';
import { errorMessage } from '@shared/errors';
import { ruleKind } from '@shared/ruleKinds';
import { MS_PER_MIN } from '@shared/units';
import type { RuleAction } from '@shared/rules';
import { TIMED_RUN_ACTION_MARK } from '@shared/ruleTime';
import { getSetting, setSetting, type Db } from '../db';
import type { ActionResult, RuleActions } from './actions';
import type { CompiledRule } from './compile';
import type { RuleEngine } from './engine';
import type { WindowDue } from './kinds';
import { claimRun, lastScheduledRun, lastTimedRun, recordOutcome } from './ruleStore';

/** How often due rules are checked; a daily rule starts within this of its time. */
const TICK_MS = MS_PER_MIN;
/**
 * App-start windows actions still owe (their plugin was off), by `<rule id>:<action id>`: where each starts and the
 * rule's arming it belongs to. Kept across quits until the action runs; turning the rule off and on voids it.
 */
const OWED_APP_STARTS_KEY = 'rules.owedAppStarts';
type OwedAppStarts = Record<string, { sinceTs: number; armedAt: number }>;

/** Archived channels in a rule's Where: a channel covers its threads, a server its channels. null = every one. */
export function scopeChannels(db: Db, r: Pick<CompiledRule, 'channels' | 'guilds'>): string[] | null {
  if (!r.channels && !r.guilds) return null;
  return db
    .prepare(
      `SELECT id FROM channels WHERE opted_in = 1
         AND (id IN (SELECT value FROM json_each(@channels)) OR parent_id IN (SELECT value FROM json_each(@channels))
              OR guild_id IN (SELECT value FROM json_each(@guilds)))`,
    )
    .pluck()
    .all({
      channels: JSON.stringify([...(r.channels ?? [])]),
      guilds: JSON.stringify([...(r.guilds ?? [])]),
    }) as string[];
}

/** Claims due window rules and executes their actions in phase order. */
export class RuleSchedule {
  private started = false;
  private busy = false;
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

  /** Runs each due timed rule, one after another. */
  async tick(): Promise<void> {
    if (this.busy || !this.db.open) return; // the database closes while the archive is moved
    this.busy = true;
    try {
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

  /** Records an app-start window `considered` still owes, once per arming; written at once, so a quit keeps it. */
  private keepOwed(considered: string, sinceTs: number, armedAt: number): void {
    const owed = this.owed();
    if (owed[considered]?.armedAt === armedAt) return; // already owed from an earlier start: the wider window stays
    setSetting(this.db, OWED_APP_STARTS_KEY, { ...owed, [considered]: { sinceTs, armedAt } });
  }

  private forgetOwed(drop: (considered: string) => boolean): void {
    const owed = this.owed();
    const kept = Object.fromEntries(Object.entries(owed).filter(([k]) => !drop(k)));
    if (Object.keys(kept).length !== Object.keys(owed).length) setSetting(this.db, OWED_APP_STARTS_KEY, kept);
  }

  /**
   * Runs the rule's due actions over their windows. Each action keeps its own progress: one whose plugin is off (or
   * absent) sits out, its window still owed (an app-start one across quits), while the others run alone; once back it
   * catches up from where it left off, then runs on the rule's schedule again.
   */
  private async runIfDue(r: CompiledRule): Promise<void> {
    const t = r.spec.trigger;
    const kind = this.engine.kinds.windows.get(t.type);
    if (!kind) return;
    const now = this.now();
    const channelIds = scopeChannels(this.db, r);
    const coveredFrom = (sinceTs: number) => this.engine.kinds.windows.covered({ sinceTs, channelIds });
    const ruleRunAt = lastScheduledRun(this.db, r.id);
    const once = kind.oncePerSession(t.config);
    const owed = this.owed();
    const due = r.spec.actions.flatMap((a) => {
      const considered = `${r.id}:${a.id}`;
      const o = owed[considered];
      const dueNow = () =>
        kind.due(t.config, {
          now,
          armedAt: r.armedAt,
          lastRunAt: lastTimedRun(this.db, r.id, a.id),
          ruleRunAt,
          sessionStart: this.sessionStart,
          lastSeenAt: this.lastSeenAt,
          appStartDone: this.appStartDone.has(considered),
          owedSince: o?.armedAt === r.armedAt ? o.sinceTs : null,
          coveredFrom,
        });
      if (this.engine.kinds.unavailable('actions', a.type)) {
        const owes = once ? dueNow() : null; // others' windows stay owed through their own last run
        if (owes) this.keepOwed(considered, owes.sinceTs, r.armedAt);
        return [];
      }
      const d = dueNow();
      if (once) {
        this.appStartDone.add(considered);
        if (!d && o) this.forgetOwed((k) => k === considered);
      }
      return d ? [{ a, d }] : [];
    });
    const ordered = ['match', 'after'].flatMap((phase) =>
      due.filter(({ a }) => (ruleKind('actions', a.type)?.phase ?? 'after') === phase),
    );
    const key = ordered[0]?.d.key;
    const whole = ordered.length === r.spec.actions.length && ordered.every(({ d }) => d.key === key);
    const runs = whole ? [{ key: key!, actions: ordered }] : ordered.map((x) => ({ key: `${x.d.key}${TIMED_RUN_ACTION_MARK}${x.a.id}`, actions: [x] }));
    let ran = false;
    for (const run of runs) ran = (await this.execute(r, run.key, run.actions, now, channelIds, once)) || ran;
    if (ran) this.emit({ type: 'rules-changed' });
  }

  /**
   * Claims the run, then executes its actions in order, each over its own window; false when already claimed or the rule
   * was deleted. An action whose plugin turned off since it was found due sits out, its window owed as if never claimed.
   */
  private async execute(
    r: CompiledRule,
    key: string,
    actions: { a: RuleAction; d: WindowDue }[],
    now: number,
    channelIds: string[] | null,
    once: boolean,
  ): Promise<boolean> {
    // Claimed before running: a failing provider is reported once per due time, not retried every tick.
    const runId = claimRun(this.db, r.id, key, null, true, now);
    if (runId === null) return false;
    this.forgetOwed((k) => actions.some(({ a }) => k === `${r.id}:${a.id}`));
    for (const { a, d } of actions) {
      const event = { kind: 'window' as const, range: { sinceTs: d.sinceTs, untilTs: now, channelIds }, timing: d.timing };
      const unavailable = this.engine.kinds.unavailable('actions', a.type);
      if (unavailable && once) {
        const considered = `${r.id}:${a.id}`;
        this.appStartDone.delete(considered);
        this.keepOwed(considered, d.sinceTs, r.armedAt);
      }
      let result: ActionResult;
      try {
        result = unavailable ? { outcome: 'skipped', detail: unavailable } : await this.actions.run(a, { rule: r, runId, history: false, actionId: a.id, event });
      } catch (err) {
        result = { outcome: 'failed', detail: errorMessage(err) };
      }
      try {
        recordOutcome(this.db, runId, a.id, a.type, result.outcome, result.detail, this.now(), unavailable !== null);
      } catch {
        return false; // the rule was deleted meanwhile (its runs went with it)
      }
    }
    return true;
  }
}
