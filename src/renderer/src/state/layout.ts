import { containedRoot } from '@plugin-sdk/renderer/containment';
import { createMemo } from 'solid-js';
import {
  canCollapse, findSlot, insertTile, normalize, removeTile, setActiveTab, setSlotCollapsed, tileIds,
  type TileNode,
} from '@cujuju/solidjs-tiling-window-manager';
import { bundledPanel } from '@shared/bundledPlugins';
import { SETTINGS_KEYS } from '@shared/settings';
import { DEFAULT_TILES } from '@/layout/presets';
import { foldPanel, migrateLegacy } from '@/layout/legacy';
import { restoreHidden, shownTree } from '@/layout/tiles';
import type { LayoutPanelId } from '@/layout/types';
import { panelOwnerOff } from '@/layout/visibility';
import { createSetting, sameIds } from '@plugin-sdk/renderer/settings';
import { pluginActive, plugins } from './plugins';
import { isDialogPanel, openPanelDialog, openPanelWindow, outsideLayout, setPlacingPanel } from './ui';

// Legacy settings are read only: other worktrees still use their original format.
const [legacyPreset] = createSetting<unknown>(SETTINGS_KEYS.layoutPreset, null, (v) => v);
const [legacyCustom] = createSetting<unknown>(SETTINGS_KEYS.layoutCustom, null, (v) => v);
const [legacySizes] = createSetting<unknown>('layout.sizes', null, (v) => v);
const [legacySidebar] = createSetting<unknown>(SETTINGS_KEYS.layoutSidebarCollapsed, false, (v) => v);
const [legacyCollapsed] = createSetting<unknown>(SETTINGS_KEYS.layoutCollapsedPanels, null, (v) => v);
const [savedTiles, saveTiles] = createSetting<TileNode | null>(SETTINGS_KEYS.layoutTiles, null, (v) => normalizeTiles(v));

function normalizeTiles(v: unknown): TileNode | null {
  const root = normalize(v);
  return (root && removeTile(root, 'status-bar')) ?? null;
}
const base = containedRoot(() => createMemo(() => migrateLegacy(legacyPreset(), legacyCustom(), legacySizes(), legacySidebar(), legacyCollapsed(), DEFAULT_TILES)));
const storedTiles = (): TileNode => savedTiles() ?? base();
const hiddenIds = containedRoot(() => createMemo(() => tileIds(storedTiles()).filter((id) =>
  panelOwnerOff(id, (panel) => bundledPanel(panel)?.pluginId, pluginActive, plugins())), [], { equals: sameIds }));
/** The stored tile tree with inactive plugin panels hidden. */
export const shownTiles = containedRoot(() => createMemo(() => shownTree(storedTiles(), new Set(hiddenIds()))));
/** Panel IDs in the visible tile tree. */
export const layoutPanelIds = containedRoot(() => createMemo(() => tileIds(shownTiles()), [], { equals: sameIds }));

/** Saves an edited visible tree while preserving hidden panels. */
export function setShownTiles(next: TileNode | undefined): void {
  if (next === shownTiles()) return;
  const restored = restoreHidden(storedTiles(), next, new Set(hiddenIds()));
  if (!restored) return;
  void saveTiles(restored);
}
/** Starts tile placement or reveals an already placed panel. */
export function startPlacing(id: LayoutPanelId): void {
  if (outsideLayout) return openPanel(id);
  if (isPlaced(id)) return revealPanel(id);
  setPlacingPanel(id);
}
/** Clears the pending panel placement. */
export const cancelPlacing = (): void => { setPlacingPanel(null); };
/** Saves the placed tile tree and clears pending placement. */
export function placePanel(_id: LayoutPanelId, next: TileNode): void {
  setShownTiles(next);
  cancelPlacing();
}
/** Removes a panel from the visible tile tree. */
export const removeLayoutPanel = (id: LayoutPanelId): void => setShownTiles(removeTile(shownTiles(), id));
/** Removes a panel from the layout and opens its window. */
export function popOutPanel(id: LayoutPanelId): void {
  removeLayoutPanel(id);
  openPanelWindow(id);
}
/** Saves the default tile tree, replacing any migrated custom layout. */
export const resetLayout = (): void => { void saveTiles(DEFAULT_TILES); };
/** Reports whether a panel belongs to this window's visible layout. */
export const isPlaced = (id: string): boolean => !outsideLayout && layoutPanelIds().includes(id);
/** Reports whether a placed panel is folded vertically. */
export const isPanelCollapsed = (id: string): boolean => {
  const edge = isPlaced(id) ? findSlot(shownTiles(), id)?.slot.collapsed?.edge : undefined;
  return edge === 'top' || edge === 'bottom';
};
/** Reports whether a placed panel can fold vertically or is already folded. */
export const canFoldPanel = (id: LayoutPanelId): boolean => isPlaced(id) && (isPanelCollapsed(id)
  || canCollapse(shownTiles(), id, 'top').allowed || canCollapse(shownTiles(), id, 'bottom').allowed);
/** Folds or unfolds a placed panel vertically. */
export function setPanelCollapsed(id: string, collapsed: boolean): void {
  const root = shownTiles();
  if (!root || !isPlaced(id)) return;
  if (collapsed) setShownTiles(foldPanel(root, id));
  else if (isPanelCollapsed(id)) setShownTiles(setSlotCollapsed(root, id, null));
}
/** Reports whether the channels rail is collapsed horizontally. */
export const sidebarCollapsed = (): boolean => {
  const edge = findSlot(shownTiles(), 'channels')?.slot.collapsed?.edge;
  return edge === 'left' || edge === 'right';
};
/** Collapses or expands the channels rail along an available horizontal edge. */
export function setSidebarCollapsed(value: boolean): void {
  const root = shownTiles();
  if (!root) return;
  const edge = (['left', 'right'] as const).find((edge) => canCollapse(root, 'channels', edge).allowed);
  if (!value) setShownTiles(setSlotCollapsed(root, 'channels', null));
  else if (edge) setShownTiles(setSlotCollapsed(root, 'channels', edge));
}
/** Unfolds and selects a placed panel, or opens an unplaced panel. */
export function revealPanel(id: LayoutPanelId): void {
  if (!isPlaced(id)) return openPanel(id);
  let root = setSlotCollapsed(shownTiles()!, id, null);
  const slot = findSlot(root, id)!.slot;
  if (slot.kind === 'tabs') root = setActiveTab(root, id, slot.children.findIndex((child) => child.id === id));
  setShownTiles(root);
}
/** Inserts an unplaced panel below the first placed anchor and reveals it. */
export function showPanel(id: LayoutPanelId, anchors: readonly LayoutPanelId[]): void {
  const anchor = anchors.find(isPlaced);
  if (!isPlaced(id) && anchor && shownTiles()) setShownTiles(insertTile(shownTiles()!, id, anchor, 'bottom'));
  revealPanel(id);
}
/** Reveals a placed panel or opens its dialog or window. */
export function openPanel(id: LayoutPanelId): void {
  if (outsideLayout || !isDialogPanel(id)) return openPanelWindow(id);
  if (isPlaced(id)) return revealPanel(id);
  openPanelDialog(id);
}
export type SidebarMode = 'servers' | 'dms';
/** Persists whether the sidebar browses servers or direct messages. */
export const [sidebarMode, setSidebarMode] = createSetting<SidebarMode>('layout.sidebarMode', 'servers', (v) => v === 'dms' ? 'dms' : 'servers');
/** Persists whether the channels sidebar is browsing servers. */
export const [browsingServers, setBrowsingServers] = createSetting<boolean>(SETTINGS_KEYS.channelsBrowsing, false, (v) => v === true);
