// Jev feature descriptions contributed by active owners.
import { stampedName, type PluginDescriptor } from '@shared/bundledTypes';
import type { PluginJevFeature } from '@shared/settings';
import type { JevFeatureInfo, JevFeatureView } from '../views/settings/jevFeatures';

/** Display metadata paired with the descriptor that owns its switches. */
export interface JevSlotEntry {
  plugin: PluginDescriptor;
  contributions: { jevFeatures?: Readonly<Record<string, JevFeatureView>> };
}

/** Active owners' declared switches by stamped key, named by their declaration; plugins cannot replace host rows. */
export function jevFeatureSlots(
  entries: readonly JevSlotEntry[],
  active: (id: string) => boolean,
): Partial<Record<PluginJevFeature, JevFeatureInfo>> {
  return Object.fromEntries(entries.filter((entry) => active(entry.plugin.manifest.id)).flatMap((entry) =>
    (entry.plugin.jev?.features ?? []).flatMap((feature) => {
      const view = entry.contributions.jevFeatures?.[feature.key];
      return view ? [[stampedName(entry.plugin.manifest.id, feature.key), { ...view, label: feature.label ?? feature.key }]] : [];
    })));
}
