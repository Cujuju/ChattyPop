// Read-only conversion of v1 layout settings.
import { canCollapse, normalize, setSlotCollapsed, type TileNode } from '@cujuju/solidjs-tiling-window-manager';
import { recordOf, stringsOr } from '@shared/normalize';
import { bakeSizes, isLayoutDoc } from './tree';
import type { LayoutNode } from './types';

const REMOVED_IDS = new Set(['status-bar', 'topics', 'rules', 'sync-status']);
const UNIT_SHARE = 1;

export function convertLegacyNode(node: LayoutNode): unknown {
  if (node.kind === 'panel') return REMOVED_IDS.has(node.id) ? null : { kind: 'tile', id: node.id };
  const children = node.children.map(convertLegacyNode);
  if (node.kind === 'tabs') return { ...node, children };
  const numeric = node.sizes.filter((s): s is number => typeof s === 'number');
  const mean = numeric.length ? numeric.reduce((a, b) => a + b, 0) / numeric.length : UNIT_SHARE;
  return { ...node, children, sizes: node.sizes.map((s) => s === 'auto' ? mean : s) };
}

const isSizes = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0);
export const readLegacyLayouts = recordOf(isLayoutDoc, (id) => id.startsWith('custom-'));
export const readLegacySizes = recordOf((v): v is Record<string, number[]> => !!v && typeof v === 'object');

export function foldPanel(root: TileNode, id: string): TileNode {
  const edge = (['top', 'bottom'] as const).find((edge) => canCollapse(root, id, edge).allowed);
  return edge ? setSlotCollapsed(root, id, edge) : root;
}

export function migrateLegacy(preset: unknown, custom: unknown, sizes: unknown, sidebar: unknown, collapsed: unknown, fallback: TileNode): TileNode {
  const doc = typeof preset === 'string' ? readLegacyLayouts(custom)[preset] : undefined;
  const overrides = typeof preset === 'string' ? readLegacySizes(sizes)[preset] : undefined;
  // Built-in presets other than stacked are gone; their saved selection uses the new default.
  let root = doc ? normalize(convertLegacyNode(bakeSizes(doc.root, recordOf(isSizes)(overrides)))) ?? fallback : fallback;
  if (sidebar === true && canCollapse(root, 'channels', 'left').allowed) root = setSlotCollapsed(root, 'channels', 'left');
  for (const id of stringsOr([])(collapsed)) root = foldPanel(root, id);
  return root;
}
