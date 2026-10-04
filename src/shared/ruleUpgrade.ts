// Version conversion is independent of kind availability and validation.
import { MESSAGE_TRIGGER } from './ruleKinds/host';
import type { RuleSpec } from './rules';
import { RULE_SPEC_VERSION } from './rules';
// Frozen v3 identities: upgrades must work even in builds without their original owner.
/** Stored managed-rule keys mapped to their fixed v4 match kinds. */
const BUILTIN_MATCH: Readonly<Record<string, string>> = {
  aimed_at_me: 'alerts.aimed',
  open_questions: 'alerts.openQuestion',
  'alerts.aimed_at_me': 'alerts.aimed',
  'alerts.open_questions': 'alerts.openQuestion',
};

type Json = Record<string, unknown>;
/** v1 → v2: AND-ed conditions became gates, alternative matches and narrowing; any action accepting backfill enabled the missed gate. */
function upgradeV1(spec: Json): Json {
  const trigger = spec.trigger as Json;
  // The topics-into-rules migration rewrites topicMatch before these version upgrades.
  if (trigger.kind === 'topicMatch') throw new Error('The rule could not be read.');
  const c = (spec.conditions ?? {}) as Json;
  const actions = (spec.actions as Json[]).map(({ backfill: _backfill, ...a }) =>
    a.kind === 'notify' ? { ...a, toast: a.toast ? { cooldownMs: (a.toast as Json).cooldownMs } : null } : a,
  );
  const pick = (keys: string[]): Json =>
    Object.fromEntries(keys.filter((k) => c[k] !== undefined).map((k) => [k, c[k]]));
  return {
    v: 2,
    trigger: trigger.kind === MESSAGE_TRIGGER ? { kind: MESSAGE_TRIGGER } : trigger,
    gates: {
      ...pick(['guildIds', 'channelIds', 'authorIds', 'authorsNot']),
      edits: trigger.kind === MESSAGE_TRIGGER && trigger.edits === true,
      missed: (spec.actions as Json[]).some((a) => a.backfill === true),
    },
    // A v1 keyword and Jev condition become alternatives; no such combined rule existed when v2 shipped.
    match: pick(['text', 'jev']),
    narrow: pick(['contains', 'linkPlatforms', 'linkDomains', 'tagIds']),
    actions,
  };
}

/** v2 → v3: only an action that moved into a plugin changed, and no public build saved one. */
const upgradeV2 = (spec: Json): Json => ({ ...spec, v: 3 });

/** v3 → v4: configuration bags become kind parts; built-ins gain explicit matches, and Jev retains its precedence over meaning. */
export function upgradeV3(spec: Json, builtin: string | null = null): Json {
  const t = spec.trigger as Json;
  const { kind, ...config } = t;
  const match = (spec.match ?? {}) as Json;
  const narrow = (spec.narrow ?? {}) as Json;
  const parts = (o: Json) =>
    Object.entries(o)
      .filter(([, value]) => value !== undefined)
      .map(([type, config]) => ({ type, config }));
  const actionTypes: Record<string, string> = {
    notify: 'alerts.notify',
    tag: 'tags.apply',
    summarize: 'summaries.summarize',
    plugin: 'command',
    file: 'file',
  };
  return {
    ...spec,
    v: 4,
    trigger:
      kind === MESSAGE_TRIGGER
        ? { type: MESSAGE_TRIGGER, config: null }
        : kind === 'tagApplied'
          ? { type: 'tags.applied', config }
          : { type: 'timed', config: t },
    match:
      builtin && BUILTIN_MATCH[builtin]
        ? [{ type: BUILTIN_MATCH[builtin], config: null }]
        : parts(match).filter((p) => p.type !== 'meaning' || !match.jev),
    narrow: parts(narrow).map((p) => (p.type === 'tagIds' ? { type: 'tags.any', config: { tagIds: p.config } } : p)),
    actions: (spec.actions as Json[]).map(({ id, kind, ...config }) =>
      kind === 'pluginAction' ? { id, ...config } : { id, type: actionTypes[String(kind)] ?? kind, config },
    ),
  };
}

/** Upgrades from each older version to the next. */
const UPGRADES: Readonly<Record<number, (spec: Json, builtin: string | null) => Json>> = {
  1: upgradeV1,
  2: upgradeV2,
  3: upgradeV3,
};

/** Upgrades stored or imported JSON independently of which plugins this build includes. */
export function upgradeRuleSpec(json: string, builtin: string | null = null): RuleSpec {
  let spec: Json;
  try {
    spec = JSON.parse(json) as Json;
  } catch {
    throw new Error('The rule could not be read.');
  }
  if (!spec || typeof spec.v !== 'number') throw new Error('The rule could not be read.');
  if (spec.v > RULE_SPEC_VERSION)
    throw new Error(`Saved by a newer ChattyPop (rule format ${spec.v}); update to run it.`);
  while (Number(spec.v) < RULE_SPEC_VERSION) {
    const up = UPGRADES[Number(spec.v)];
    if (!up) throw new Error('The rule could not be read.');
    spec = up(spec, builtin);
  }
  return spec as unknown as RuleSpec;
}
