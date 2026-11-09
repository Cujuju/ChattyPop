// Default layouts with declared plugin panels inserted at preset anchors.
import { bundledPanels } from '@shared/bundledPlugins';
import type { PanelDecl } from '@shared/bundledTypes';
import { placePresetPanels } from './presetPanels';
import { collapseSingles } from './tree';
import { normalize, tileIds, type TileNode } from '@cujuju/solidjs-tiling-window-manager';
import { convertLegacyNode } from './legacy';
import { removePanel, panelIds } from './tree';
import { PANEL_TITLES } from '../panels/titles';
import type { LayoutNode, LayoutPanelId, PanelRef, SplitSize } from './types';

/** Presets include built-in and bundled panels. Unavailable plugin panels collapse out; tests validate ids against possible build panels. */
const panel = (id: LayoutPanelId): PanelRef => ({ kind: 'panel', id });
const row = (sizes: SplitSize[], ...children: LayoutNode[]): LayoutNode => ({ kind: 'split', dir: 'row', sizes, children });
const col = (sizes: SplitSize[], ...children: LayoutNode[]): LayoutNode => ({ kind: 'split', dir: 'column', sizes, children });

/** Sidebar column shared by every preset: channels, with any plugin panel placed beside it; a lone child collapses out. */
const sidebar = col([1], panel('channels'));
// Split fractions below reproduce F2's proportions (sidebar ≈ 1/6, insight ≈ 2/5 of height).
const SIDEBAR_SHARE = 1;
const WORKSPACE_SHARE = 5;

const insightRow = row([3, 2, 2], col(['auto'], panel('provider')), panel('alerts'), panel('links'));

const STACKED = col([1, 'auto'], row([SIDEBAR_SHARE, WORKSPACE_SHARE], sidebar, col([2, 3], insightRow, panel('chat'))), panel('status-bar'));

/** Plugin declarations are placed before unavailable anchors and the fixed status bar disappear. */
export function buildDefaultTiles(panels: readonly PanelDecl[]): TileNode {
  const available = new Set([...Object.keys(PANEL_TITLES), ...panels.map((p) => p.id)]);
  let root: LayoutNode | null = collapseSingles(placePresetPanels(STACKED, 'stacked', panels));
  for (const id of panelIds(root)) if (!available.has(id)) root = root && removePanel(root, id);
  return normalize(root && convertLegacyNode(root))!;
}

export const DEFAULT_TILES = buildDefaultTiles(bundledPanels());
export const DEFAULT_PANEL_IDS: ReadonlySet<string> = new Set(tileIds(DEFAULT_TILES));
