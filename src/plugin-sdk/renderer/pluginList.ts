// Plugin SDK, renderer: the window's one plugin list (docs/plugin-architecture.md §8). The SDK owns it, so plugins'
// isActive/callable and host stores (state/plugins.ts re-exports it) read a single fetch over the @/api leaf.
import { api, windowAudience } from '@/api';
import { createResource, createSignal } from 'solid-js';
import { BUNDLED_PLUGINS, channelAudiences } from '@shared/bundledPlugins';
import type { PluginDescriptor } from '@shared/bundledTypes';
import { onAppEvent } from './appEvents';
import type { WindowMember } from './clients';

const [loaded, setLoaded] = createSignal(false);
/** Whether the plugin list has arrived from core. Reactive. */
export const pluginsLoaded = loaded;

/** Bundled plugins and those found in the plugins folder, with status and commands. */
const [list, { refetch }] = createResource(
  () =>
    api.core.plugins().then((all) => {
      setLoaded(true);
      return all;
    }),
  { initialValue: [] },
);
export const plugins = list;
onAppEvent('plugins-changed', () => void refetch());

/**
 * Whether bundled plugin `id` is on (Settings → Plugins). Until the plugin list arrives, whether this build includes it
 * (plugins start on), so its UI never appears late. Reactive.
 */
export const pluginActive = (id: string): boolean =>
  pluginsLoaded() ? plugins().some((p) => p.id === id && p.bundled && p.status === 'active') : BUNDLED_PLUGINS.some((p) => p.manifest.id === id);

/** Whether this window may make bundled plugin `id`'s core call `name`: it is on, and the call's audiences include this window. Reactive. */
export const pluginMayCall = (id: string, name: string): boolean => pluginActive(id) && channelAudiences(id, 'core', name).includes(windowAudience());

/** Whether this window may call `plugin`'s core `name` now (pluginMayCall), typed to the members windows may call. Reactive. */
export const callable = <D extends PluginDescriptor>(plugin: D, name: WindowMember<D>): boolean => pluginMayCall(plugin.manifest.id, name);
