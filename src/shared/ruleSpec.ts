// Rule JSON: reading a stored spec with version upgrades, checking edits and creating actions with defaults.
import { orList } from './lists';
import { newGates } from './ruleGates';
export { newGates } from './ruleGates';
import { MESSAGE_TRIGGER } from './ruleKinds/host';
import { SNOWFLAKE_ID } from './discord';
import { ruleKind, ruleKinds, type RuleSection } from './ruleKinds';
import { BUNDLED_PLUGINS } from './bundledPlugins';
import { localManagedKey } from './bundledTypes';
import {
  RULE_SPEC_VERSION,
  type RuleAction,
  type RuleGates,
  type RuleInput,
  type RulePart,
  type RuleSpec,
} from './rules';
import { upgradeRuleSpec } from './ruleUpgrade';

export { upgradeV3, upgradeRuleSpec } from './ruleUpgrade';

/** Upgrades and validates stored structure, preserving unavailable plugin configurations for editing. */
export function parseRuleSpec(json: string, builtin: string | null = null): RuleSpec {
  const spec = upgradeRuleSpec(json, builtin);
  validateRuleSpec(spec, true, builtin);
  return spec;
}

/** Checks the rule name, its parts and its permission to act as the owner. */
export function validateRuleInput(input: RuleInput, builtin: string | null = null): void {
  if (!input.name.trim()) throw new Error('Name the rule.');
  validateRuleSpec(input.spec, input.discordSend, builtin);
}
/**
 * Checks a part against its kind. A plugin part this build lacks is kept unchecked, so the rule still loads and saves;
 * ruleUnavailable says why it can't run.
 */
function validatePart<S extends RuleSection>(section: S, p: RulePart) {
  const k = ruleKind(section, p.type);
  if (!k) {
    if (!/^[^.]+\.[^.]+/.test(p.type)) throw new Error('The rule could not be read.');
    return null;
  }
  k.validate(p.config);
  return k;
}

/** Validates parts and cross-part constraints; throws a message for the editor. */
export function validateRuleSpec(
  spec: RuleSpec,
  discordSend: boolean,
  builtin: string | null = null,
): void {
  if (spec.v !== RULE_SPEC_VERSION) throw new Error('The rule could not be read.');
  const trigger = validatePart('triggers', spec.trigger);
  const g = spec.gates;
  if (typeof g.edits !== 'boolean' || typeof g.missed !== 'boolean') throw new Error('The rule could not be read.');
  if (g.authorIds?.some((id) => !SNOWFLAKE_ID.test(id))) throw new Error('Pick each person again.');
  for (const [section, parts] of [
    ['match', spec.match],
    ['filters', spec.narrow],
  ] as const) {
    if (new Set(parts.map((p) => p.type)).size !== parts.length)
      throw new Error('A kind may appear only once in each match or narrowing.');
    for (const p of parts) validatePart(section, p);
  }
  const asked = spec.match.filter((p) => ruleKind('match', p.type)?.asksJev);
  if (asked.length > 1) throw new Error('Pick at most one match that asks Jev.');
  if (asked.length && spec.trigger.type !== MESSAGE_TRIGGER)
    throw new Error('Matching by meaning or a Jev question works only when the rule starts on new messages.');
  // Scheduled windows cover time and channels, not individual message matches or authors.
  if (trigger?.event === 'window') {
    if (spec.match.length || spec.narrow.length)
      throw new Error(
        'A rule that runs on a schedule acts on a stretch of time, not on messages: clear what it matches.',
      );
    if (g.authorIds?.length) throw new Error('A rule that runs on a schedule covers everyone: clear who it is for.');
  }
  if (builtin) {
    for (const plugin of BUNDLED_PLUGINS) {
      const key = localManagedKey(plugin.manifest.id, builtin) ?? plugin.adopts?.managedRules?.[builtin];
      if (key) plugin.managedRules?.[key]?.(spec);
    }
  }
  if (!spec.actions.length) throw new Error('Add at least one action.');
  if (new Set(spec.actions.map((a) => a.id)).size !== spec.actions.length)
    throw new Error('The rule could not be read.');
  for (const a of spec.actions) {
    const k = validatePart('actions', a);
    if (!k) continue;
    if (trigger && !k.targets.includes(trigger.event))
      throw new Error(
        trigger.event === 'window'
          ? `A rule that runs on a schedule can only ${windowActionsText()}.`
          : 'This action cannot act on a message.',
      );
    if (k.actsAsYou && !discordSend) throw new Error('Turn on "Post to Discord as you" to let this rule post.');
  }
}

/** What a scheduled rule may do, from the actions that act on windows, e.g. "summarize or run a plugin command". */
function windowActionsText(): string {
  const verbs = ruleKinds('actions')
    .filter((k) => k.targets.includes('window'))
    .map((k) => k.label.charAt(0).toLowerCase() + k.label.slice(1));
  return orList(verbs);
}

/** A new host or bundled plugin action with its declared defaults. */
export function newRuleAction(type: string, id: string = crypto.randomUUID()): RuleAction {
  const k = ruleKind('actions', type);
  if (!k) throw new Error(`No rule action ${type} in this ChattyPop.`);
  return { id, type, config: k.create() };
}

/** A new rule: every new message, alerting. */
export const newRuleInput = (): RuleInput => ({
  name: '',
  enabled: true,
  discordSend: false,
  spec: {
    v: RULE_SPEC_VERSION,
    trigger: { type: MESSAGE_TRIGGER, config: null },
    gates: newGates(),
    match: [],
    narrow: [],
    actions: ruleKinds('actions').filter((kind) => kind.defaultForNewRule).slice(0, 1).map((kind) => newRuleAction(kind.type)),
  },
});
