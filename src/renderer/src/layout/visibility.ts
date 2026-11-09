// A displayed layout projects stored splits without losing hidden panels or their fractions.
import { isPluginPanelId, pluginOfPanelId, type PluginInfo } from '@shared/plugins';

/** Known inactive owners hide their panels; removed owners leave ids available for the missing-panel placeholder. */
export function panelOwnerOff(
  id: string,
  bundledOwner: (id: string) => string | undefined,
  active: (id: string) => boolean,
  plugins: readonly Pick<PluginInfo, 'id' | 'bundled' | 'conflict' | 'status'>[],
): boolean {
  const owner = bundledOwner(id);
  if (owner) return !active(owner);
  if (!isPluginPanelId(id)) return false;
  const folder = plugins.find((p) => !p.bundled && !p.conflict && p.id === pluginOfPanelId(id));
  return !!folder && folder.status !== 'active';
}
