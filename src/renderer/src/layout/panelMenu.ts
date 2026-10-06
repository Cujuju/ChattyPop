import { optionalPanelsFirst } from './menuOrder';
import { PRESETS } from './presets';
import { placeByAnchor } from '@shared/anchors';
import { bundledPanel, panelAnchor } from '@shared/bundledPlugins';
import { isPluginPanelId } from '@shared/plugins';
import { activeBundledPanels } from '@/plugins/slots';
import { MOVABLE_PANELS, PANEL_TITLES, type PanelId } from '@/panels/titles';
import { addPanelBelow, currentLayout, deleteCustomLayout, isCustomLayout, layoutId, removeLayoutPanel, setRenamingLayout, swapLayoutPanels } from '@/state/layout';
import { findPluginPanel, pluginPanels } from '@/state/pluginPanels';
import { openPanelWindow, setDraggedPanel, type MenuGroup, type MenuItem } from '@/state/ui';
import { panelIds, type DropZone } from './tree';
import type { LayoutPanelId } from './types';

/** Panels the user may rearrange: every panel except the frame (sidebar, status bar). */
export const movable = (id: LayoutPanelId): boolean => isPluginPanelId(id) || MOVABLE_PANELS.has(id as PanelId) || bundledPanel(id) !== null;
/** Panels that can leave the layout or open in their own window: all movable ones but Chat, which hosts the live Discord view. */
export const detachable = (id: LayoutPanelId): boolean => movable(id) && id !== 'chat';
const EVERY_ZONE: readonly DropZone[] = ['left', 'right', 'top', 'bottom', 'center'];
/** The sidebar (Archive) column splits above or below Channels; the frame itself never moves, so no swap. */
const SIDEBAR_ZONES: readonly DropZone[] = ['top', 'bottom'];
/** Returns allowed panel drop zones. External center replacements require removable targets; non-droppable targets return none. */
export function dropZones(target: LayoutPanelId, dragged: LayoutPanelId): readonly DropZone[] {
  const zones = movable(target) ? EVERY_ZONE : target === 'channels' ? SIDEBAR_ZONES : [];
  const adding = !panelIds(currentLayout().root).includes(dragged);
  return adding && !detachable(target) ? zones.filter((z) => z !== 'center') : zones;
}

/** A panel's title; its id when unknown (a removed plugin's, or one a saved layout still names). */
export const titleOf = (id: string): string =>
  (isPluginPanelId(id) ? findPluginPanel(id)?.title : ((PANEL_TITLES as Record<string, string>)[id] ?? bundledPanel(id)?.title)) ?? id;

/** Drag props for a control that moves panel `id` (null: not draggable) into the layout (see LayoutRoot DropZones). */
export const panelDragProps = (id: () => LayoutPanelId | null): { readonly draggable: boolean; onDragStart: (e: DragEvent) => void; onDragEnd: () => void } => ({
  get draggable(): boolean {
    return id() !== null;
  },
  onDragStart: (e: DragEvent): void => {
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    setDraggedPanel(id());
  },
  onDragEnd: (): void => void setDraggedPanel(null),
});

/** Built-in panels in PANEL_TITLES order, each active bundled panel placed after its anchor: the order of the top bar and the panel menus. Reactive. */
export const panelOrder = (): LayoutPanelId[] =>
  placeByAnchor<LayoutPanelId>(Object.keys(PANEL_TITLES), activeBundledPanels().map((p) => p.id), (id) => id, panelAnchor);

/** Panels on the top bar's toolbar: every one that can open in a window or be dragged into the layout. */
export const toolbarPanels = (): LayoutPanelId[] => [...panelOrder().filter(detachable), ...pluginPanels().map((p) => p.layoutId)];

/** Panel header menu opens windows, swaps/adds/removes panels, and renames/deletes custom layouts. */
export function panelMenu(id: LayoutPanelId): MenuGroup[] {
  if (!movable(id)) return [];
  const inLayout = panelIds(currentLayout().root);
  // Panels no preset shows first (built-in optional ones and bundled ones), then the rest of the top bar's.
  const order = panelOrder();
  const presetPanels = new Set(Object.values(PRESETS).flatMap((preset) => panelIds(preset.root)));
  const addable: MenuItem[] = optionalPanelsFirst(order.filter(detachable), presetPanels)
    .filter((p) => !inLayout.includes(p))
    .map((p) => ({ label: titleOf(p), icon: 'plus' as const, run: () => addPanelBelow(id, p) }));
  for (const p of pluginPanels().filter((p) => !inLayout.includes(p.layoutId))) addable.push({ label: p.title, icon: 'plus', run: () => addPanelBelow(id, p.layoutId) });
  return [
    {
      heading: titleOf(id),
      items: detachable(id)
        ? [
            { label: 'Open in a window', icon: 'window', run: () => openPanelWindow(id) },
            { label: 'Remove from this layout', icon: 'close', run: () => removeLayoutPanel(id) },
          ]
        : [],
    },
    { heading: 'Swap with', items: inLayout.filter((p) => p !== id && movable(p)).map((other) => ({ label: titleOf(other), icon: 'swap' as const, run: () => swapLayoutPanels(id, other) })) },
    { heading: 'Add below', items: addable },
    ...layoutMenu(),
  ];
}

/** Menu for the current layout (panel headers, the top bar's layout switcher): rename or delete it when custom. */
export function layoutMenu(): MenuGroup[] {
  const id = layoutId();
  if (!isCustomLayout(id)) return [];
  return [
    {
      heading: `Layout “${currentLayout().name}”`,
      items: [
        { label: 'Rename…', icon: 'edit', run: () => void setRenamingLayout(id) },
        { label: 'Delete', icon: 'trash', danger: true, run: () => deleteCustomLayout(id) },
      ],
    },
  ];
}
