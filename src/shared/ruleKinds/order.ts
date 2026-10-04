// Rule editor placement independent of the bundled registry.
import { placeByAnchor } from '../anchors';
import type { PluginDescriptor } from '../bundledTypes';
import { HOST } from './catalog';
import type { RuleSection, RuleSections } from './types';

/** Orders declarations around host or plugin kinds, appending unanchored kinds in declaration order. */
export function orderedRuleKinds<S extends RuleSection>(section: S, plugins: readonly PluginDescriptor[]): RuleSections[S][] {
  const extra = plugins.flatMap((p) => p.rules?.[section] ?? []) as RuleSections[S][];
  const kinds = new Map([...HOST[section], ...extra].map((kind) => [kind.type, kind]));
  return placeByAnchor<RuleSections[S]>(
    HOST[section],
    extra,
    (kind) => kind.type,
    (type) => {
      const kind = kinds.get(type);
      return kind?.before ? { before: kind.before } : kind?.after;
    },
  );
}
