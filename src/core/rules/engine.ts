// Rule firing: claim once, run match-phase actions synchronously, then after actions in order.
import { readHistory } from './history';
import type { AppEvent } from '@shared/contract';
import { errorMessage } from '@shared/errors';
import { recordedKind, type RuleAction } from '@shared/rules';
import { MESSAGE_TRIGGER } from '@shared/ruleKinds/host';
import { ruleKind } from '@shared/ruleKinds';
import type { Hit } from './hit';
import { isLive, type LiveAt, type TextMessage } from '../arrival';
import type { Db } from '../db';
import type { ActionResult, RuleActions } from './actions';
import {
  compileRule,
  directMatch,
  factsReader,
  gatesPass,
  narrowPasses,
  type CompiledRule,
  type MessageFacts,
} from './compile';
import { claimRun, loadRule, recordOutcome, ruleRows } from './ruleStore';
import type { ActionRun, RuleKinds, TriggerEvent } from './kinds';

/** Coalesces a burst of action outcomes into one renderer update. */
const RULE_EVENT_DEBOUNCE_MS = 250;
export { MISSED_SKIPPED } from './actions';
/** A message event’s run key: a rule fires once per message, edits included. */
export const messageKey = (m: TextMessage): string => `msg:${m.id}`;
/** Whether the rule has an action that also handles matches older than the rule. */
export const hasHistory = (r: CompiledRule): boolean =>
  r.spec.actions.some((a) => ruleKind('actions', a.type)?.history);
/** Keeps compiled rules and executes claimed events in phase order. */
export class RuleEngine {
  private eventCounter = 0;
  private compiled: CompiledRule[] = [];
  readonly facts: (m: TextMessage) => MessageFacts;
  readonly kinds: RuleKinds;
  private pendingEvent: NodeJS.Timeout | undefined;
  constructor(
    private readonly db: Db,
    private readonly emit: (e: AppEvent) => void,
    private readonly actions: RuleActions,
    private readonly now: () => number = Date.now,
  ) {
    this.kinds = actions.kinds;
    this.facts = factsReader(db);
    this.kinds.bindTriggers((type, e) => this.trigger(type, e));
    this.kinds.bindHistory((type, id) => {
      const rule = this.find(id);
      return rule ? readHistory(db, rule, this.facts, type) : null;
    });
    this.kinds.bindChanged(() => this.reload());
    this.reload();
  }

  /** A distinct identity for each arrival check, trigger fire or past-message judgment. */
  nextEventId(): number {
    return ++this.eventCounter;
  }

  /** Re-reads the rules after any change. */
  reload(): void {
    this.compiled = ruleRows(this.db).flatMap((row) => compileRule(loadRule(row), this.kinds) ?? []);
    this.kinds.reloaded();
  }

  /** Enabled arrival rules, in run order, for the matcher to evaluate. */
  messageRules(): CompiledRule[] {
    return this.compiled.filter((r) => r.spec.trigger.type === MESSAGE_TRIGGER);
  }

  /** Enabled window rules, in run order, for RuleSchedule. */
  timedRules(): CompiledRule[] {
    return this.compiled.filter((r) => ruleKind('triggers', r.spec.trigger.type)?.event === 'window');
  }

  /** The currently compiled rule, or undefined when deleted or disabled. */
  find(id: number): CompiledRule | undefined {
    return this.compiled.find((r) => r.id === id);
  }

  /** A declared message trigger; triggers raised inside actions are refused before reaching here. */
  private trigger(type: string, e: TriggerEvent): void {
    const eventId = this.nextEventId();
    const f = this.facts(e.m);
    const ctx = { live: isLive(e.liveAt), edit: false, mayAct: () => false };
    for (const r of this.compiled) {
      if (r.spec.trigger.type !== type || !e.accepts(r.spec.trigger.config)) continue;
      if (!gatesPass(r, f, ctx) || !narrowPasses(r, f)) continue;
      const hit = directMatch(r, f);
      if (hit) this.fire(r, e.m, hit, e.liveAt, eventId, e.key);
    }
    this.kinds.settle({ eventId, m: e.m, answers: null });
  }

  /** Claims the event once, runs match-phase actions synchronously, then starts after-phase actions in order. */
  fire(r: CompiledRule, m: TextMessage, hit: Hit, liveAt: LiveAt, eventId: number, eventKey = messageKey(m)): boolean {
    const live = isLive(liveAt);
    const runId = claimRun(this.db, r.id, eventKey, m, live, this.now());
    if (runId === null) return false;
    const run = { rule: r, runId, history: false, event: { kind: 'message' as const, eventId, m, hit, live, liveAt } };
    for (const a of r.spec.actions.filter((a) => ruleKind('actions', a.type)?.phase === 'match'))
      this.runMatch(a, { ...run, actionId: a.id });
    void this.runAfter(r, run);
    return true;
  }

  /** An older message runs only history actions, without claiming or recording a rule run. */
  recordHistory(r: CompiledRule, m: TextMessage, hit: Hit, eventId: number): void {
    const run: Omit<ActionRun, 'actionId'> = {
      rule: r,
      runId: null,
      history: true,
      event: { kind: 'message', eventId, m, hit, live: false, liveAt: null },
    };
    for (const a of r.spec.actions.filter(
      (a) => ruleKind('actions', a.type)?.history && ruleKind('actions', a.type)?.phase === 'match',
    )) {
      this.runMatch(a, { ...run, actionId: a.id });
    }
    void this.runAfter(r, run);
  }
  private runMatch(a: RuleAction, run: ActionRun): void {
    let result: ActionResult;
    try {
      result = this.actions.run(a, run) as ActionResult;
    } catch (err) {
      result = { outcome: 'failed', detail: errorMessage(err) };
    }
    if (run.runId !== null) this.record(run.runId, a, result);
  }
  private async runAfter(r: CompiledRule, run: Omit<ActionRun, 'actionId'>): Promise<void> {
    for (const a of r.spec.actions.filter((a) => (ruleKind('actions', a.type)?.phase ?? 'after') === 'after')) {
      if (run.history && !ruleKind('actions', a.type)?.history) continue;
      let result: ActionResult;
      try {
        result = await this.actions.run(a, { ...run, actionId: a.id });
      } catch (err) {
        result = { outcome: 'failed', detail: errorMessage(err) };
      }
      if (run.runId !== null) this.record(run.runId, a, result);
    }
  }
  private record(runId: number, a: RuleAction, result: ActionResult): void {
    try {
      recordOutcome(this.db, runId, a.id, recordedKind(a), result.outcome, result.detail, this.now());
    } catch {
      return; // the rule was deleted meanwhile (its runs went with it)
    }
    this.changed();
  }

  private changed(): void {
    this.pendingEvent ??= setTimeout(() => {
      this.pendingEvent = undefined;
      this.emit({ type: 'rules-changed' });
    }, RULE_EVENT_DEBOUNCE_MS);
  }
}
