// Plugin windows: in-app floating windows a plugin opens per key (a comparison id), several of a kind open at once.
import { createSignal } from 'solid-js';
import type { PluginDescriptor } from '@shared/bundledTypes';
import { raiseWindow } from './windows';

/** One open plugin window: its plugin, the window kind its renderer side declares, and the key it shows. */
export interface PluginWindowRef {
  plugin: string;
  window: string;
  key: string;
}

/** Open plugin windows, in the order they opened. */
export const [openPluginWindows, setOpenPluginWindows] = createSignal<readonly PluginWindowRef[]>([]);

const sameWindow = (a: PluginWindowRef, b: PluginWindowRef): boolean => a.plugin === b.plugin && a.window === b.window && a.key === b.key;
const refOf = (plugin: PluginDescriptor, window: string, key: string): PluginWindowRef => ({ plugin: plugin.manifest.id, window, key });

/** Its FloatingWindow id; windows of one kind share `pluginWindowKind`'s geometry. */
export const pluginWindowId = (r: PluginWindowRef): string => `${pluginWindowKind(r)}:${r.key}`;
export const pluginWindowKind = (r: PluginWindowRef): string => `plugin:${r.plugin}.${r.window}`;

/** Whether `plugin`'s window `window` is open for `key`. Reactive. */
export const pluginWindowOpen = (plugin: PluginDescriptor, window: string, key: string): boolean =>
  openPluginWindows().some((w) => sameWindow(w, refOf(plugin, window, key)));

/** Opens `plugin`'s window `window` for `key` in the main window, or brings it to the front. */
export function openPluginWindow(plugin: PluginDescriptor, window: string, key: string): void {
  const ref = refOf(plugin, window, key);
  if (pluginWindowOpen(plugin, window, key)) raiseWindow(pluginWindowId(ref));
  else setOpenPluginWindows([...openPluginWindows(), ref]);
}

export function closePluginWindow(plugin: PluginDescriptor, window: string, key: string): void {
  closeWindow(refOf(plugin, window, key));
}

/** Closes one open window by its ref (its own close button, or a plugin that turned off). */
export const closeWindow = (ref: PluginWindowRef): void => void setOpenPluginWindows(openPluginWindows().filter((w) => !sameWindow(w, ref)));
