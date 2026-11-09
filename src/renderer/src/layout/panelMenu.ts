import { optionalPanelsFirst } from './menuOrder';
import { DEFAULT_PANEL_IDS } from './presets';
import { placeByAnchor } from '@shared/anchors';
import { bundledPanel, panelAnchor } from '@shared/bundledPlugins';
import { isPluginPanelId } from '@shared/plugins';
import { activeBundledPanels } from '@/plugins/slots';
import { PANEL_TITLES } from '@/panels/titles';
import { layoutPanelIds, openPanel, removeLayoutPanel, resetLayout, startPlacing } from '@/state/layout';
import { findPluginPanel, pluginPanels } from '@/state/pluginPanels';
import { openPanelWindow, type MenuGroup } from '@/state/ui';
import type { LayoutPanelId } from './types';

/** Panels that must stay in the layout: Channels (the sidebar) and Chat (hosts the live Discord view). */
const ANCHORED_PANELS: ReadonlySet<string> = new Set(['channels', 'chat']);
/** Panels that can leave the layout or open in their own window. */
export const detachable = (id: LayoutPanelId): boolean => !ANCHORED_PANELS.has(id) && id !== 'status-bar';

/** A panel's title; its id when unknown (a removed plugin's, or one a saved layout still names). */
export const titleOf = (id: string): string =>
  (isPluginPanelId(id) ? findPluginPanel(id)?.title : ((PANEL_TITLES as Record<string, string>)[id] ?? bundledPanel(id)?.title)) ?? id;

/** Built-in panels in PANEL_TITLES order, each active bundled panel placed after its anchor: the order of the top bar and the panel menus. Reactive. */
export const panelOrder = (): LayoutPanelId[] =>
  placeByAnchor<LayoutPanelId>(Object.keys(PANEL_TITLES), activeBundledPanels().map((p) => p.id), (id) => id, panelAnchor);

/** Panels on the top bar's toolbar: every one that can open in a window or be placed in the layout. */
export const toolbarPanels = (): LayoutPanelId[] => [...panelOrder().filter(detachable), ...pluginPanels().map((p) => p.layoutId)];

/** Panels the layout doesn't show, optional ones (no default spot) first, then plugin panels. Reactive. */
function addablePanels(): LayoutPanelId[] {
  const shown = new Set(layoutPanelIds());
  return [...optionalPanelsFirst(panelOrder().filter(detachable), DEFAULT_PANEL_IDS), ...pluginPanels().map((p) => p.layoutId)].filter((id) => !shown.has(id));
}

/** Layout-wide items: place a panel that isn't shown, or go back to the default layout. */
export function layoutMenu(): MenuGroup[] {
  return [
    { heading: 'Add a panel', items: addablePanels().map((id) => ({ label: titleOf(id), icon: 'plus' as const, run: () => startPlacing(id) })) },
    { heading: 'Layout', items: [{ label: 'Reset to the default layout', icon: 'undo', danger: true, run: resetLayout }] },
  ];
}

/** A placed panel's header menu: open it in a window or take it out, then the layout-wide items. */
export function panelMenu(id: LayoutPanelId): MenuGroup[] {
  return [
    {
      heading: titleOf(id),
      items: detachable(id)
        ? [
            { label: 'Open in a window', icon: 'window', run: () => openPanelWindow(id) },
            { label: 'Remove from the layout', icon: 'close', run: () => removeLayoutPanel(id) },
          ]
        : [],
    },
    ...layoutMenu(),
  ];
}

/** A top bar panel button's menu: open it, or place it in the layout when it isn't there. */
export function toolbarMenu(id: LayoutPanelId): MenuGroup[] {
  const placed = layoutPanelIds().includes(id);
  return [
    {
      heading: titleOf(id),
      items: [
        { label: placed ? 'Show in the layout' : 'Open', icon: 'window', run: () => openPanel(id) },
        ...(placed ? [] : [{ label: 'Place in the layout…', icon: 'plus' as const, run: () => startPlacing(id) }]),
      ],
    },
  ];
}
