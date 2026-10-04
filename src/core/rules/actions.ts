// Rule action execution: permissions, live-only gates, declared floors and outcomes.
import { ruleKind } from '@shared/ruleKinds';
import type { RuleAction, RuleOutcome } from '@shared/rules';
import { ACTION_INTERVALS } from '@shared/ruleKinds/intervals';
import type { Db } from '../db';
import type { RuleKinds, ActionRun } from './kinds';
import { lastDone } from './ruleStore';

/** The outcome and optional detail recorded for one action in a rule run. */
export interface ActionResult {
  outcome: RuleOutcome;
  detail: string | null;
}

/** Why a live-only action did not act on a message that arrived while the app was closed. */
export const MISSED_SKIPPED =
  'Not run: the message arrived while ChattyPop was closed, and this action acts on live messages only.';
const skipped = (detail: string): ActionResult => ({ outcome: 'skipped', detail });
/** Applies execution flags before invoking each registered action implementation. */
export class RuleActions {
  /** Active actions block overlapping runs, protecting plan quota and plugin time; keyed by rule id and action id. */
  private readonly running = new Set<string>();

  constructor(
    private readonly db: Db,
    readonly kinds: RuleKinds,
    private readonly now: () => number = Date.now,
  ) {}

  /** Applies opt-in, live-only and interval guards; timed runs rely on their schedule for spacing. */
  run(a: RuleAction, r: ActionRun): ActionResult | Promise<ActionResult> {
    const kind = ruleKind('actions', a.type);
    const reason = this.kinds.unavailable('actions', a.type);
    if (reason) return skipped(reason);
    if (!kind) return skipped(`No rule action ${a.type}.`);
    if (kind.actsAsYou && !r.rule.discordSend)
      return skipped('Not posted: "Let this rule post to Discord as you" is off.');
    if (r.event.kind === 'message' && !r.event.live && kind.liveOnly) return skipped(MISSED_SKIPPED);
    const key = `${r.rule.id}:${a.id}`;
    const floor = kind.minIntervalMs;
    if (floor !== null) {
      if (this.running.has(key)) return skipped('Not run: still running from an earlier run.');
      const last = r.event.kind === 'message' ? lastDone(this.db, r.rule.id, a.id) : null;
      if (last !== null && this.now() - last < floor) {
        const text = ACTION_INTERVALS[floor]!;
        return skipped(
          `Not run: this action runs at most once per ${text.unit}, and last ran less than ${text.span} ago.`,
        );
      }
      this.running.add(key);
    }
    try {
      const result = this.kinds.run(a.type, a.config, r);
      if (result instanceof Promise) {
        if (kind.phase === 'match') {
          void result.catch(() => undefined);
          throw new Error('A match-phase action must finish synchronously.');
        }
        return result.finally(() => this.running.delete(key));
      }
      this.running.delete(key);
      return result;
    } catch (err) {
      this.running.delete(key);
      throw err;
    }
  }
}
