// Unified lookup of host and bundled plugin kind views.
import type { RuleSection } from '@shared/ruleKinds';
import { pluginKindView } from '@/plugins/slots';
import type { RemovableFilter } from './filters';
import type { KindView } from './types';
import { actionViews } from './actions';
import { matchViews } from './match';
import { filterViews } from './filters';
import { triggerViews } from './triggers';

const VIEWS: Record<RuleSection, Record<string, KindView>> = {
  triggers: triggerViews,
  match: matchViews,
  filters: filterViews,
  actions: actionViews,
};

/** Finds the host or plugin editor and summary for a declared kind. */
export const kindView = (section: RuleSection, type: string): KindView | undefined => VIEWS[section][type] ?? pluginKindView(section, type);
/** Host filters own per-entry chip removal; plugin editors own their chips. */
export const filterView = (type: string): RemovableFilter | undefined => filterViews[type];
/** A trigger view with optional host-specific picker choices. */
export const triggerView = (type: string) =>
  triggerViews[type] ?? (pluginKindView('triggers', type) as typeof triggerViews[string] | undefined);
