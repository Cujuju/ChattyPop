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
import { BookmarksPanel } from './bookmarks';
import { StatusBarPanel } from './status-bar';
import { Contained, contained } from '@/ui/contained';

export interface PanelDef {
  title: string;
  component: Component;
}

const COMPONENTS: Record<PanelId, Component> = {
  channels: ChannelsPanel,
  'sync-status': SyncStatusPanel,
  chat: ChatPanel,
  bookmarks: BookmarksPanel,
  'status-bar': StatusBarPanel,
};

/** Every named section of the UI. Layouts refer to panels only by these ids. */
export const PANELS = Object.fromEntries(Object.entries(COMPONENTS).map(([id, component]) => [id, { title: PANEL_TITLES[id as PanelId], component: contained(PANEL_TITLES[id as PanelId], component, { header: { section: id } }) }])) as Record<PanelId, PanelDef>;

const ContainedPluginPanel = (props: Parameters<typeof PluginPanelSlot>[0]) => createComponent(Contained, {
  get name() { return findPluginPanel(props.id)?.title ?? 'Plugin panel'; },
  get shows() { return { header: { section: 'plugin', panelId: props.id } }; },
  get children() { return createComponent(PluginPanelSlot, props); },
});

export type { PanelId };

/** Resolves built-in/plugin panel ids reactively. Enabled plugin panels mount through slots; toggling on makes them available. */
export function lookupPanel(id: string): PanelDef | undefined {
  if (isPluginPanelId(id)) return { title: findPluginPanel(id)?.title ?? id, component: () => createComponent(ContainedPluginPanel, { id }) };
  const bundled = bundledPanel(id);
  const component = bundled && panelComponent(id);
  if (bundled) return component ? { title: bundled.title, component } : undefined;
  return (PANELS as Record<string, PanelDef>)[id];
}
