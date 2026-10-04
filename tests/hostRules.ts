// The host's rule services with no plugin's kinds, and rule inputs: what any plugin's rule tests build on.
import { upgradeV3 } from '@shared/ruleUpgrade';
import type { RuleAction, RuleGates, RuleInput, RuleSpec } from '@shared/rules';
import { newGates } from '@shared/ruleSpec';
import type { AppEvent } from '@shared/contract';
import type { JevFeature } from '@shared/settings';
import type { DecisionProvider } from '../src/core/ai/decisions';
import type { Db } from '../src/core/db';
import type { ActionDeps } from '../src/core/rules/hostActions';
import { createRuleActions } from '../src/core/rules/hostKinds';
import { RuleEngine } from '../src/core/rules/engine';
import { RuleMatcher } from '../src/core/rules/matcher';
import { RuleService } from '../src/core/rules/ruleService';
import type {
  LegacyRuleMatch as RuleMatch,
  LegacyRuleNarrow as RuleNarrow,
  LegacyRuleTrigger as RuleTrigger,
} from './ruleFixtures';

/** Host actions with nothing behind them: a command action fails. */
const NO_HOST_DEPS: ActionDeps = {
  runPluginCommand: () => Promise.reject(new Error('no plugins in this test')),
};

/**
 * The host's rule services over `db`, wired as core wires them, with no plugin's kinds registered. The engine reloads
 * on every kind registration, so a plugin's kinds may follow it.
 */
export function hostRuleStack(
  db: Db,
  emit: (e: AppEvent) => void,
  jevFor: (feature: JevFeature) => DecisionProvider | null,
  deps: ActionDeps = NO_HOST_DEPS,
  now: () => number = Date.now,
) {
  const actions = createRuleActions(db, deps, emit, now);
  const engine = new RuleEngine(db, emit, actions, now);
  const matcher = new RuleMatcher(db, engine, jevFor);
  const rules = new RuleService(db, emit, engine, matcher, now);
  return { engine, actions, matcher, rules };
}

/** A rule input: every new message unless `trigger`, gates, match or narrow say otherwise. */
export function ruleInput(
  actions: RuleAction[],
  o: {
    trigger?: RuleTrigger;
    gates?: Partial<RuleGates>;
    match?: RuleMatch;
    narrow?: RuleNarrow;
    discordSend?: boolean;
    name?: string;
  } = {},
): RuleInput {
  return {
    name: o.name ?? 'R',
    enabled: true,
    discordSend: o.discordSend ?? false,
    spec: {
      ...upgradeV3({
        v: 3,
        trigger: o.trigger ?? { kind: 'message' },
        gates: { ...newGates(), ...o.gates },
        match: o.match ?? {},
        narrow: o.narrow ?? {},
        actions: [],
      }),
      actions,
    } as unknown as RuleSpec,
  };
}

/** More runs than any rule test makes. */
const RUNS_READ = 100;

/** Each run of a rule as [message id, live, [action outcome…]], oldest first. */
export function runsOf(h: { rules: Pick<RuleService, 'runs'> }, ruleId: number): [string | null, boolean, string[]][] {
  return h.rules
    .runs(ruleId, RUNS_READ)
    .reverse()
    .map((r) => [r.messageId, r.live, r.actions.map((a) => a.outcome)]);
}
