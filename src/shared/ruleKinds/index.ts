// Rule kind lookup across host and bundled plugin declarations.
import { BUNDLED_PLUGINS } from '../bundledPlugins';
import type { PluginDescriptor } from '../bundledTypes';
import { orderedRuleKinds } from './order';
import type { RuleSection, RuleSections } from './types';
export type * from './types';

type Registry = { ordered: readonly RuleSections[RuleSection][]; byType: Map<string, RuleSections[RuleSection]> };
const registry = new Map<RuleSection, Registry>();
/** The descriptors the registry was built from; any change to the list (test probes) rebuilds it. */
let builtFrom: readonly unknown[] = [...BUNDLED_PLUGINS];

function sectionRegistry(section: RuleSection): Registry {
  if (builtFrom.length !== BUNDLED_PLUGINS.length || builtFrom.some((d, i) => d !== BUNDLED_PLUGINS[i])) {
    registry.clear();
    builtFrom = [...BUNDLED_PLUGINS];
  }
  let entry = registry.get(section);
  if (!entry) {
    const ordered = Object.freeze(orderedRuleKinds(section, BUNDLED_PLUGINS));
    entry = { ordered, byType: new Map(ordered.map((kind) => [kind.type, kind])) };
    registry.set(section, entry);
  }
  return entry;
}

/** Immutable declarations in editor order, cached per section. */
export function ruleKinds<S extends RuleSection>(section: S): readonly RuleSections[S][] {
  return sectionRegistry(section).ordered as readonly RuleSections[S][];
}

/** A declared kind by section and type; null when none is declared. */
export type RuleKindLookup = <S extends RuleSection>(section: S, type: string) => RuleSections[S] | null;

/** Constant-time lookup of a declared kind. */
export const ruleKind: RuleKindLookup = <S extends RuleSection>(section: S, type: string): RuleSections[S] | null =>
  sectionRegistry(section).byType.get(type) as RuleSections[S] | undefined ?? null;

/** ruleKind over the host's kinds and `installed`'s instead of this build's registry. */
export function ruleKindLookup(installed: readonly PluginDescriptor[]): RuleKindLookup {
  const bySection = new Map<RuleSection, Map<string, RuleSections[RuleSection]>>();
  return <S extends RuleSection>(section: S, type: string): RuleSections[S] | null => {
    let kinds = bySection.get(section);
    if (!kinds) bySection.set(section, (kinds = new Map(orderedRuleKinds(section, installed).map((kind) => [kind.type, kind]))));
    return (kinds.get(type) as RuleSections[S] | undefined) ?? null;
  };
}
