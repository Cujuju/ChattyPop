// Rule view lookup and badge collection independent of renderer startup.
import type { ManagedRuleControl } from '../state/managedControls';
import type { JSX } from 'solid-js';
import type { RuleSection } from '@shared/ruleKinds/types';
import type { Rule } from '@shared/rules';
import { ruleKindPlugin } from '@shared/ruleAvailability';
import { localManagedKey, stampedName } from '@shared/bundledTypes';
import type { JevFeature } from '@shared/settings';
import type { KindView, FilterView } from '../views/settings/rules/kinds/types';

/** The rule contributions consumed by the host's rule slots. */
export type RuleSlotEntry = {
  plugin: {
    manifest: {
      id: string;
    };
  };
  contributions: {
    rules?: {
      managedControls?: Readonly<Record<string, ManagedRuleControl>>;
      activity?(rule: Rule): string | null;
      ruleBadge?(rule: Rule): JSX.Element | null;
    } & { [S in RuleSection]?: Readonly<Record<string, KindView | FilterView>> };
  };
};

/** Creates lookups whose active-state reads stay inside the caller's reactive scope. */
export function ruleSlots(entries: () => readonly RuleSlotEntry[], active: (id: string) => boolean) {
  return {
    control: (rule: Rule): ManagedRuleControl | undefined => {
      for (const entry of entries()) {
        if (!active(entry.plugin.manifest.id)) continue;
        const key = localManagedKey(entry.plugin.manifest.id, rule.builtin);
        if (key !== null) return entry.contributions.rules?.managedControls?.[key];
      }
      return undefined;
    },
    /** Active owners' switches that managed rules replace, stamped. */
    features: (): JevFeature[] => entries().flatMap((entry) => active(entry.plugin.manifest.id)
      ? Object.values(entry.contributions.rules?.managedControls ?? {}).flatMap((c) => (c.feature ? [stampedName(entry.plugin.manifest.id, c.feature)] : [])) : []),
    activity: (rule: Rule): string[] => entries().flatMap((entry) => active(entry.plugin.manifest.id) ? entry.contributions.rules?.activity?.(rule) ?? [] : []),
    view: (section: RuleSection, type: string): KindView | FilterView | undefined => {
      for (const entry of entries()) {
        const view = entry.contributions.rules?.[section]?.[type];
        if (view) return view;
      }
      return undefined;
    },
    offered: (type: string): boolean => {
      const id = ruleKindPlugin(type);
      return id === null || active(id);
    },
    badges: (rule: Rule): JSX.Element[] => entries().flatMap((entry) => active(entry.plugin.manifest.id) ? entry.contributions.rules?.ruleBadge?.(rule) ?? [] : []),
  };
}
