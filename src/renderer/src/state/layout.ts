import { createMemo, createSignal } from 'solid-js';
import { bundledPanel } from '@shared/bundledPlugins';
import { SETTINGS_KEYS } from '@shared/settings';
import { PRESETS, type PresetId } from '@/layout/presets';
import { bakeSizes, effectiveSizes, insertBelow, isLayoutDoc, movePanel, panelIds, panelShowing, removePanel, retirePanel, swapPanels, type DockSide } from '@/layout/tree';
import type { LayoutDoc, LayoutNode, LayoutPanelId } from '@/layout/types';
import type { TabPicks } from '@/layout/tabSelection';
import { editStoredLayout, panelOwnerOff, projectLayout, projectedSizes } from '@/layout/visibility';
import { createSetting, sameIds } from '@plugin-sdk/renderer/settings';
import { recordOf, stringsOr } from '@shared/normalize';
import { pluginActive, plugins } from './plugins';
import { isDialogPanel, openPanelDialog, openPanelWindow, outsideLayout } from './ui';

/** A preset id, or a custom layout's id (custom-<n>). */
export type LayoutId = string;

/** F2, the chosen design, is the stacked layout. */
const DEFAULT_LAYOUT: PresetId = 'stacked';
const CUSTOM_PREFIX = 'custom-';

/** The chosen layout. Any id is kept: custom layouts load separately, and an unknown id falls back in currentLayout(). */
export const [layoutId, setLayoutId] = createSetting<LayoutId>(SETTINGS_KEYS.layoutPreset, DEFAULT_LAYOUT, (v) => (typeof v === 'string' && v ? v : DEFAULT_LAYOUT));

/** Retired panels: a saved layout shows the one each became, or drops it (null). Topics merged into Rules, then Rules moved into Settings. */
const RETIRED_PANELS: readonly (readonly [string, LayoutPanelId | null])[] = [
  ['topics', null],
  ['rules', null],
];
const readLayouts = recordOf(isLayoutDoc, (id) => id.startsWith(CUSTOM_PREFIX));

/** Saved layouts a retired panel was taken out of since they were stored; migrateRetiredPanels writes them back. */
const reshaped = new Set<LayoutId>();

/** Saved layouts with retired panels replaced; one left empty is dropped. */
function normalizeLayouts(v: unknown): Record<LayoutId, LayoutDoc> {
  return Object.fromEntries(
    Object.entries(readLayouts(v)).flatMap(([id, doc]) => {
      const root = RETIRED_PANELS.reduce<LayoutNode | null>((node, [from, to]) => node && retirePanel(node, from, to), doc.root);
      if (root !== doc.root) reshaped.add(id);
      return root ? [[id, { ...doc, root }]] : [];
    }),
  );
}

/** Layouts the user made by moving panels; presets themselves never change. */
export const [customLayouts, setCustomLayouts, { loaded: customLayoutsLoaded }] = createSetting<Record<LayoutId, LayoutDoc>>(SETTINGS_KEYS.layoutCustom, {}, normalizeLayouts);

/** Both presets and custom layouts hide panels whose known owner is off. */
const hiddenPanel = (id: string): boolean => panelOwnerOff(id, (panel) => bundledPanel(panel)?.pluginId, pluginActive, plugins());
const isPreset = (id: LayoutId): id is PresetId => id in PRESETS;
const storedLayout = (): LayoutDoc => (isPreset(layoutId()) ? PRESETS[layoutId() as PresetId] : customLayouts()[layoutId()]) ?? PRESETS[DEFAULT_LAYOUT];
/** An entirely hidden layout has no slots, but retains its stored tree. */
const EMPTY_LAYOUT: LayoutNode = { kind: 'split', dir: 'row', sizes: [], children: [] };
export const currentLayout = (): LayoutDoc => ({ ...storedLayout(), root: projection().root ?? EMPTY_LAYOUT });
export const isCustomLayout = (id: LayoutId): boolean => id in customLayouts();

/** Bakes path-keyed split fractions into trees before structural edits and clears them afterward. Editing presets first creates custom copies. */
function editLayout(edit: (root: LayoutNode) => LayoutNode | null): void {
  const root = editStoredLayout(storedLayout().root, sizeOverrides()[layoutId()], edit);
  if (!root) return;
  const customs = customLayouts();
  let id = layoutId();
  let name = storedLayout().name;
  if (!isCustomLayout(id)) {
    const n = Math.max(0, ...Object.keys(customs).map((k) => Number(k.slice(CUSTOM_PREFIX.length)) || 0)) + 1;
    id = `${CUSTOM_PREFIX}${n}`;
    name = `Custom ${n}`;
  }
  setCustomLayouts({ ...customs, [id]: { version: 1, name, root } });
  const { [id]: _baked, ...otherSizes } = sizeOverrides();
  setSizeOverrides(otherSizes);
  setLayoutId(id);
}

export const swapLayoutPanels = (a: LayoutPanelId, b: LayoutPanelId): void => editLayout((root) => swapPanels(root, a, b));
/** Adds a panel (a plugin's) below another. */
export const addPanelBelow = (target: LayoutPanelId, id: LayoutPanelId): void => editLayout((root) => insertBelow(root, target, id));
/** Moves a panel to one side of another (drag and drop). */
export const moveLayoutPanel = (id: LayoutPanelId, target: LayoutPanelId, side: DockSide): void =>
  editLayout((root) => movePanel(root, id, target, side));
export const removeLayoutPanel = (id: LayoutPanelId): void => editLayout((root) => removePanel(root, id));

/** Longest layout name: keeps the top bar's layout switcher from crowding the panel toolbar. */
export const LAYOUT_NAME_MAX = 32;

/** Renames a custom layout (presets keep theirs). A blank name leaves it unchanged. */
export function renameCustomLayout(id: LayoutId, name: string): void {
  const doc = customLayouts()[id];
  const trimmed = name.trim().slice(0, LAYOUT_NAME_MAX);
  if (!doc || !trimmed || trimmed === doc.name) return;
  setCustomLayouts({ ...customLayouts(), [id]: { ...doc, name: trimmed } });
}

/** The custom layout whose name the top bar is editing, or null. */
export const [renamingLayout, setRenamingLayout] = createSignal<LayoutId | null>(null);

export function deleteCustomLayout(id: LayoutId): void {
  const { [id]: _gone, ...rest } = customLayouts();
  setCustomLayouts(rest);
  const { [id]: _sizes, ...otherSizes } = sizeOverrides();
  setSizeOverrides(otherSizes);
  if (layoutId() === id) setLayoutId(DEFAULT_LAYOUT);
}

/** Split path: child indexes from the layout root, e.g. "0.1". */
export type SplitPath = string;
type SizeOverrides = Partial<Record<LayoutId, Record<SplitPath, number[]>>>;

const LAYOUT_SIZES_KEY = 'layout.sizes';
const isSizes = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0);
const normalizeSizes = (v: unknown): SizeOverrides => {
  if (!v || typeof v !== 'object') return {};
  const out: SizeOverrides = {};
  for (const [preset, byPath] of Object.entries(v)) {
    if (byPath && typeof byPath === 'object') out[preset] = recordOf(isSizes)(byPath);
  }
  return out;
};

/** User-dragged split fractions per layout; they replace the preset's numeric sizes at that path. */
const [sizeOverrides, setSizeOverrides, { loaded: sizeOverridesLoaded }] = createSetting<SizeOverrides>(LAYOUT_SIZES_KEY, {}, normalizeSizes);
/** Panels hidden now; unchanged by a plugin-list refresh that hides nothing new, so the projection isn't rebuilt. */
const hiddenIds = createMemo(() => panelIds(storedLayout().root).filter(hiddenPanel), [], { equals: sameIds });
const projection = createMemo(() => {
  const hidden = new Set(hiddenIds());
  return projectLayout(storedLayout().root, (id) => hidden.has(id));
});

/** Persists retired-panel removals once and clears dragged sizes because split paths shift. */
void Promise.all([customLayoutsLoaded, sizeOverridesLoaded]).then(() => {
  if (!reshaped.size) return;
  const ids = new Set(reshaped);
  reshaped.clear();
  setCustomLayouts(customLayouts());
  setSizeOverrides(Object.fromEntries(Object.entries(sizeOverrides()).filter(([id]) => !ids.has(id))));
});

export const splitSizes = (path: SplitPath): number[] | undefined => {
  const split = projection().splits[path];
  if (!split) return undefined;
  const sizes = effectiveSizes(split.sizes, sizeOverrides()[layoutId()]?.[split.path]);
  return split.indices.flatMap((i) => typeof sizes[i] === 'number' ? [sizes[i] as number] : []);
};

export function setSplitSizes(path: SplitPath, sizes: number[] | null): void {
  const id = layoutId();
  const byPath = { ...sizeOverrides()[id] };
  const shown = projection();
  if (sizes) {
    const sized = projectLayout(bakeSizes(storedLayout().root, byPath), hiddenPanel);
    const mapped = projectedSizes(sized, path, sizes);
    if (!mapped) return;
    byPath[mapped.path] = mapped.sizes;
  } else {
    const split = shown.splits[path];
    if (!split) return;
    delete byPath[split.path];
  }
  setSizeOverrides({ ...sizeOverrides(), [id]: byPath });
}

/** Sidebar shown as a narrow icon rail (channels as tiles, sync as a dot). */
export const [sidebarCollapsed, setSidebarCollapsed] = createSetting<boolean>(SETTINGS_KEYS.layoutSidebarCollapsed, false, (v) => v === true);

/** What the sidebar lists: archived server channels, or direct messages (docs/dms.md §4.1). */
export type SidebarMode = 'servers' | 'dms';
const SIDEBAR_MODE_KEY = 'layout.sidebarMode';
export const [sidebarMode, setSidebarMode] = createSetting<SidebarMode>(SIDEBAR_MODE_KEY, 'servers', (v) => (v === 'dms' ? 'dms' : 'servers'));
/** Servers mode lists every server to opt channels in or out, instead of the archived ones. */
export const [browsingServers, setBrowsingServers] = createSetting<boolean>(SETTINGS_KEYS.channelsBrowsing, false, (v) => v === true);

/** Panels folded to their header line (the layout gives their space to the others). */
const [collapsedPanels, setCollapsedPanels] = createSetting<string[]>(SETTINGS_KEYS.layoutCollapsedPanels, [], stringsOr([]));

/** Panels picked in tab groups, most recent first, restored on start; each group shows the first it holds (layout/tabSelection.ts). */
const [tabPickIds, setTabPickIds] = createSetting<string[]>(SETTINGS_KEYS.layoutTabPicks, [], stringsOr([]));
export const tabPicks: TabPicks = {
  recent: () => tabPickIds() as LayoutPanelId[],
  pick: (id) => {
    if (tabPickIds()[0] !== id) void setTabPickIds([id, ...tabPickIds().filter((x) => x !== id)]);
  },
};

/** Whether panel `id` is in the main window's layout. Folding and the layout menu apply only there. */
export const isPlaced = (id: string): boolean => !outsideLayout && panelIds(currentLayout().root).includes(id as LayoutPanelId);

/** A panel outside the layout (panel window, in-app window, phone) shows whole. */
export const isPanelCollapsed = (id: string): boolean => isPlaced(id) && collapsedPanels().includes(id);

export function setPanelCollapsed(id: string, collapsed: boolean): void {
  const rest = collapsedPanels().filter((x) => x !== id);
  setCollapsedPanels(collapsed ? [...rest, id] : rest);
}

/** The latest request to bring a panel into view; its slot scrolls into view and a tab group holding it selects it. A new object per request. */
export const [revealRequest, setRevealRequest] = createSignal<{ id: LayoutPanelId } | null>(null);

/** Unfolds/selects panels or opens absent panels in windows. Collapsed sidebar panels remain hidden until sidebar expansion. */
export function revealPanel(id: LayoutPanelId): void {
  if (!isPlaced(id)) return openPanel(id);
  setPanelCollapsed(id, false);
  setRevealRequest({ id });
}

/** Adds requested panels below the first available anchor; without anchors, opens a window. Avoids dependence on other plugin panels. */
export function showPanel(id: LayoutPanelId, anchors: readonly LayoutPanelId[]): void {
  const showing = outsideLayout ? { outside: true } : panelShowing(currentLayout().root, id, anchors);
  if ('below' in showing) addPanelBelow(showing.below, id);
  revealPanel(id);
}

/**
 * Top bar click. A DIALOG_PANELS panel shows in one place: in the layout when placed there, else in its in-app window.
 * Other panels open in their own app window.
 */
export function openPanel(id: LayoutPanelId): void {
  if (outsideLayout || !isDialogPanel(id)) return openPanelWindow(id);
  if (isPlaced(id)) return revealPanel(id);
  openPanelDialog(id);
}
