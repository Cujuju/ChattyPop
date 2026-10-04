import { api } from '@/api';
import { unwrapPluginCall } from '@shared/pluginCall';
import { createResource } from 'solid-js';
import { PLUGIN_SCHEME, pluginPanelId, type PluginInfo, type PluginPanelId } from '@shared/plugins';
import type { PluginPanel } from '@/plugins/types';
import { onAppEvent } from './events';
import { plugins } from './plugins';

export interface LoadedPanel extends PluginPanel {
  layoutId: PluginPanelId;
  pluginId: string;
}

/** Bumped on each load so the module loader re-reads changed renderer files. */
let generation = 0;

async function loadPanels(list: PluginInfo[]): Promise<LoadedPanel[]> {
  generation++;
  const out: LoadedPanel[] = [];
  for (const p of list) {
    if (!p.renderer) continue;
    try {
      const mod = (await import(/* @vite-ignore */ `${PLUGIN_SCHEME}://${p.id}/${p.renderer}?v=${generation}`)) as { panels?: unknown };
      const panels = Array.isArray(mod.panels) ? (mod.panels as PluginPanel[]) : [];
      for (const panel of panels) {
        if (typeof panel?.id === 'string' && typeof panel.title === 'string' && typeof panel.mount === 'function') {
          out.push({ ...panel, pluginId: p.id, layoutId: pluginPanelId(p.id, panel.id) });
        }
      }
    } catch (err) {
      console.error(`[plugin ${p.id}] renderer failed to load`, err);
    }
  }
  return out;
}

/** Panels from active plugins' renderer entries (API 1.1); reloaded when plugins change. */
export const [pluginPanels] = createResource(plugins, loadPanels, { initialValue: [] });

export const findPluginPanel = (id: string): LoadedPanel | undefined => pluginPanels().find((p) => p.layoutId === id);

/** A plugin's core-side handler (PanelApi.call). */
export const pluginCall = (pluginId: string, name: string, args: unknown[]): Promise<unknown> => api.plugins.callCore(pluginId, name, args).then(unwrapPluginCall);

/** Archive changes relayed to a panel that subscribed (PanelApi.onArchiveChanged); returns the unsubscribe. */
export const onArchiveChangedForPanels = (fn: (channelIds: string[]) => void): (() => void) => {
  const off = onAppEvent('archive-changed', (e) => fn(e.channelIds));
  return () => void off();
};
