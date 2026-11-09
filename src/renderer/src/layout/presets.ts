// Default layouts with declared plugin panels inserted at preset anchors.
import { bundledPanels } from '@shared/bundledPlugins';
import type { PanelDecl } from '@shared/bundledTypes';
import { placePresetPanels } from './presetPanels';
import { collapseSingles } from './tree';
import { normalize, tileIds, type TileNode } from '@cujuju/solidjs-tiling-window-manager';
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

/** The status bar is the frame below the workspace: placed for plugin anchors, then left out of the tiles. */
const FRAME_PANEL = 'status-bar';
const UNIT_SHARE = 1;

/** The preset tree as toolkit tiles: 'auto' sizes become the split's mean share; normalize() makes it canonical. */
function toTiles(node: LayoutNode): unknown {
  if (node.kind === 'panel') return node.id === FRAME_PANEL ? null : { kind: 'tile', id: node.id };
  const children = node.children.map(toTiles);
  if (node.kind === 'tabs') return { ...node, children };
  const numeric = node.sizes.filter((s): s is number => typeof s === 'number');
  const mean = numeric.length ? numeric.reduce((a, b) => a + b, 0) / numeric.length : UNIT_SHARE;
  return { ...node, children, sizes: node.sizes.map((s) => (s === 'auto' ? mean : s)) };
}

const STACKED = col([1, 'auto'], row([SIDEBAR_SHARE, WORKSPACE_SHARE], sidebar, col([2, 3], insightRow, panel('chat'))), panel('status-bar'));

/** Plugin declarations are placed before unavailable anchors and the fixed status bar disappear. */
export function buildDefaultTiles(panels: readonly PanelDecl[]): TileNode {
  const available = new Set([...Object.keys(PANEL_TITLES), ...panels.map((p) => p.id)]);
  let root: LayoutNode | null = collapseSingles(placePresetPanels(STACKED, 'stacked', panels));
  for (const id of panelIds(root)) if (!available.has(id)) root = root && removePanel(root, id);
  return normalize(root && toTiles(root))!;
}

export const DEFAULT_TILES = buildDefaultTiles(bundledPanels());
export const DEFAULT_PANEL_IDS: ReadonlySet<string> = new Set(tileIds(DEFAULT_TILES));
