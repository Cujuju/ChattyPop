// Plugins for host views: the SDK's single plugin list (@plugin-sdk/renderer/pluginList), and Settings → Plugins' actions.
import { api } from '@/api';
import { BUNDLED_PLUGINS } from '@shared/bundledPlugins';
import { MS_PER_DAY } from '@shared/units';
import { pluginActive, plugins, pluginsLoaded } from '@plugin-sdk/renderer/pluginList';

export { pluginActive, pluginMayCall, plugins, pluginsLoaded } from '@plugin-sdk/renderer/pluginList';

/** History a plugin command runs on from Settings: the last day. */
const COMMAND_RANGE_MS = MS_PER_DAY;

/** Reactively controls message parts by bundled enabled/folder active state. Folder parts remain shown until plugin-list load completes. */
export const pluginPresents = (id: string): boolean =>
  BUNDLED_PLUGINS.some((p) => p.manifest.id === id)
    ? pluginActive(id)
    : !pluginsLoaded() || plugins().some((p) => p.id === id && !p.bundled && p.status === 'active');

export const setPluginEnabled = (id: string, on: boolean): Promise<void> => api.core.setPluginEnabled(id, on);
export const reloadPlugins = (): Promise<void> => api.core.reloadPlugins();
export const openPluginsFolder = (): Promise<void> => api.openPluginsFolder();

/** Runs a plugin command over the last day of every archived channel; resolves with what it reported. */
export async function runPluginCommand(pluginId: string, commandId: string): Promise<string> {
  const untilTs = Date.now();
  const text = await api.core.runPluginCommand(pluginId, commandId, { sinceTs: untilTs - COMMAND_RANGE_MS, untilTs, channelIds: null });
  return text ?? 'Done.';
}
