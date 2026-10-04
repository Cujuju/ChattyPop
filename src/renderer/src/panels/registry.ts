// Components for host-owned layout panels.
import type { Component } from 'solid-js';
import { createComponent } from 'solid-js';
import { isPluginPanelId } from '@shared/plugins';
import { bundledPanel } from '@shared/bundledPlugins';
import { panelComponent } from '@/plugins/slots';
import { findPluginPanel } from '@/state/pluginPanels';
import { PANEL_TITLES, type PanelId } from './titles';
import { PluginPanelSlot } from './plugin/PluginPanelSlot';
import { ChannelsPanel } from './channels';
import { SyncStatusPanel } from './sync-status';
import { ChatPanel } from './chat';
import { StatusBarPanel } from './status-bar';

export interface PanelDef {
  title: string;
  component: Component;
}

const COMPONENTS: Record<PanelId, Component> = {
  channels: ChannelsPanel,
  'sync-status': SyncStatusPanel,
  chat: ChatPanel,
  'status-bar': StatusBarPanel,
};

/** Every named section of the UI. Layouts refer to panels only by these ids. */
export const PANELS = Object.fromEntries(Object.entries(COMPONENTS).map(([id, component]) => [id, { title: PANEL_TITLES[id as PanelId], component }])) as Record<PanelId, PanelDef>;

export type { PanelId };

/**
 * Built-in panels by id; plugin:<plugin>:<panel> ids resolve to a slot that mounts that plugin panel; a bundled plugin's
 * panel resolves while its plugin is on. Reactive: a panel appears when its plugin is turned on.
 */
export function lookupPanel(id: string): PanelDef | undefined {
  if (isPluginPanelId(id)) return { title: findPluginPanel(id)?.title ?? id, component: () => createComponent(PluginPanelSlot, { id }) };
  const bundled = bundledPanel(id);
  const component = bundled && panelComponent(id);
  if (bundled) return component ? { title: bundled.title, component } : undefined;
  return (PANELS as Record<string, PanelDef>)[id];
}
