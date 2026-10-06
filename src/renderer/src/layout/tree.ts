import type { LayoutDoc, LayoutNode, LayoutPanelId, PanelRef, SplitSize } from './types';

/** Collapses redundant split containers after declarations have been placed. */
export function collapseSingles(node: LayoutNode): LayoutNode {
  if (node.kind !== 'split') return node;
  const children = node.children.map(collapseSingles);
  return children.length === 1 ? children[0]! : { ...node, children };
}

/** Panel ids in a layout, in tree order. */
export function panelIds(node: LayoutNode): LayoutPanelId[] {
  if (node.kind === 'panel') return [node.id];
  return node.children.flatMap((c: LayoutNode) => panelIds(c));
}

/** Swaps panels without changing tree structure/sizes. If only one exists, the other replaces it. */
export function swapPanels(node: LayoutNode, a: LayoutPanelId, b: LayoutPanelId): LayoutNode {
  if (node.kind === 'panel') return node.id === a ? { kind: 'panel', id: b } : node.id === b ? { kind: 'panel', id: a } : node;
  if (node.kind === 'tabs') return { ...node, children: node.children.map((c) => swapPanels(c, a, b) as typeof c) };
  return { ...node, children: node.children.map((c) => swapPanels(c, a, b)) };
}

/** The tree with panel `id` placed below panel `target`, sharing its height equally. */
export function insertBelow(node: LayoutNode, target: LayoutPanelId, id: LayoutPanelId): LayoutNode {
  if (node.kind === 'panel') return node.id === target ? { kind: 'split', dir: 'column', sizes: [1, 1], children: [node, { kind: 'panel', id }] } : node;
  if (node.kind === 'tabs') return node.children.some((c) => c.id === target) ? { ...node, children: [...node.children, { kind: 'panel', id }] } : node;
  return { ...node, children: node.children.map((c) => insertBelow(c, target, id)) };
}

/** How a panel asked for from elsewhere is shown: where it is, below the first of its anchors the layout holds, or outside it. */
export type PanelShowing = { placed: true } | { below: LayoutPanelId } | { outside: true };

/** Showing panel `id` in `root`: never depends on an anchor being placed, since any may be off or left out of the build. */
export function panelShowing(root: LayoutNode, id: LayoutPanelId, anchors: readonly LayoutPanelId[]): PanelShowing {
  const ids = panelIds(root);
  if (ids.includes(id)) return { placed: true };
  const below = anchors.find((a) => ids.includes(a));
  return below ? { below } : { outside: true };
}

/** Removes panels and collapses single-child splits. Returns null for empty trees. */
export function removePanel(node: LayoutNode, id: LayoutPanelId): LayoutNode | null {
  if (node.kind === 'panel') return node.id === id ? null : node;
  if (node.kind === 'tabs') {
    const children = node.children.filter((c) => c.id !== id);
    if (!children.length) return null;
    return { ...node, children, active: Math.min(node.active, children.length - 1) };
  }
  const kept = node.children
    .map((c, i) => ({ c: removePanel(c, id), size: node.sizes[i]! }))
    .filter((k): k is { c: LayoutNode; size: SplitSize } => k.c !== null);
  if (!kept.length) return null;
  if (kept.length === 1) return kept[0]!.c;
  return { ...node, children: kept.map((k) => k.c), sizes: kept.map((k) => k.size) };
}

/** A saved layout with retired panel `from` shown as `to`; dropped when `to` is null or the layout already has it. */
export function retirePanel(node: LayoutNode, from: string, to: LayoutPanelId | null): LayoutNode | null {
  const retired = from as LayoutPanelId; // no longer a panel id, but still in the stored tree
  const ids = panelIds(node);
  if (!ids.includes(retired)) return node;
  return to === null || ids.includes(to) ? removePanel(node, retired) : swapPanels(node, retired, to);
}

const isSize = (s: unknown): s is SplitSize => s === 'auto' || (typeof s === 'number' && Number.isFinite(s) && s > 0);

/** Structural check for stored layouts; unknown panel ids are allowed (they render a placeholder). */
export function isLayoutNode(v: unknown): v is LayoutNode {
  if (!v || typeof v !== 'object') return false;
  const n = v as Record<string, unknown>;
  if (n['kind'] === 'panel') return typeof n['id'] === 'string';
  const children = n['children'];
  if (!Array.isArray(children) || children.length === 0) return false;
  if (n['kind'] === 'tabs') return typeof n['active'] === 'number' && children.every((c) => isLayoutNode(c) && (c as LayoutNode).kind === 'panel');
  if (n['kind'] !== 'split' || (n['dir'] !== 'row' && n['dir'] !== 'column')) return false;
  const sizes = n['sizes'];
  return Array.isArray(sizes) && sizes.length === children.length && sizes.every(isSize) && children.every(isLayoutNode);
}

export const isLayoutDoc = (v: unknown): v is LayoutDoc =>
  !!v && typeof v === 'object' && (v as LayoutDoc).version === 1 && typeof (v as LayoutDoc).name === 'string' && isLayoutNode((v as LayoutDoc).root);

/** Path of a split's child `i`: child indexes from the layout root, e.g. "0.1". */
export const childPath = (path: string, i: number): string => (path ? `${path}.${i}` : String(i));

/** Preset sizes with the user's saved fractions applied to the numeric (resizable) entries. */
export function effectiveSizes(preset: SplitSize[], saved: number[] | undefined): SplitSize[] {
  const numericCount = preset.filter((s) => s !== 'auto').length;
  if (!saved || saved.length !== numericCount) return preset; // preset shape changed: ignore stale sizes
  let k = 0;
  return preset.map((s) => (s === 'auto' ? s : saved[k++]!));
}

/** The tree with saved fractions (keyed by split path) written into its sizes, so a structural edit can't misapply them. */
export function bakeSizes(node: LayoutNode, byPath: Record<string, number[]> | undefined, path = ''): LayoutNode {
  if (node.kind !== 'split') return node;
  const children = node.children.map((c, i) => bakeSizes(c, byPath, childPath(path, i)));
  return { ...node, sizes: effectiveSizes(node.sizes, byPath?.[path]), children };
}

/** Checks content-sized extents: folded panel height or splits whose children are all content-sized along the axis; auto counts along split direction. */
export function contentSized(node: LayoutNode, axis: 'row' | 'column', isCollapsed: (id: LayoutPanelId) => boolean): boolean {
  if (node.kind === 'panel') return axis === 'column' && isCollapsed(node.id);
  if (node.kind === 'tabs') return false;
  return node.children.every((c, i) => (node.dir === axis && node.sizes[i] === 'auto') || contentSized(c, axis, isCollapsed));
}

/** Shares rescaled to sum to 1: flex-grow totals below 1 hand out only that part of the free space, leaving a gap. */
export function normalizeShares(sizes: SplitSize[]): SplitSize[] {
  const total = sizes.reduce<number>((t, s) => (s === 'auto' ? t : t + s), 0);
  return sizes.map((s) => (s === 'auto' ? s : s / total));
}

/** Index of the first share-sized entry after `i`, or -1: a resize handle after `i` trades space with it. */
export const nextShare = (sizes: SplitSize[], i: number): number => sizes.findIndex((s, k) => k > i && s !== 'auto');

/** Resizes share-sized boundary pairs from drag-start pixels/minimums, preserving combined shares. Intervening content-sized entries keep their sizes. */
export function resizeShares(sizes: SplitSize[], a: number, b: number, px: [number, number], min: [number, number], deltaPx: number): SplitSize[] {
  const [fa, fb] = [sizes[a] as number, sizes[b] as number];
  const total = px[0] + px[1];
  const pxA = Math.min(Math.max(px[0] + deltaPx, min[0]), total - min[1]);
  const next = [...sizes];
  next[a] = (pxA / total) * (fa + fb);
  next[b] = fa + fb - (next[a] as number);
  return next;
}

/** Where a dragged panel lands relative to the target panel. */
export type DockSide = 'left' | 'right' | 'top' | 'bottom';

/** A drop target's zones: an edge docks the dragged panel on that side, the middle swaps the two. */
export type DropZone = DockSide | 'center';

/** Share of a target's width or height, from each edge, that docks there when its middle also accepts a drop. */
const DOCK_EDGE_SHARE = 0.25;

/** Selects nearest allowed edge or eligible center from normalized target coordinates. Returns null when no zones are allowed. */
export function dropZoneAt(allowed: readonly DropZone[], x: number, y: number): DropZone | null {
  const dist: Record<DockSide, number> = { left: x, right: 1 - x, top: y, bottom: 1 - y };
  const nearest = allowed.reduce<DockSide | null>((a, z) => (z === 'center' || (a !== null && dist[a] <= dist[z]) ? a : z), null);
  if (allowed.includes('center') && (nearest === null || dist[nearest] >= DOCK_EDGE_SHARE)) return 'center';
  return nearest;
}

const axisOf = (side: DockSide): 'row' | 'column' => (side === 'left' || side === 'right' ? 'row' : 'column');
const pair = (target: LayoutNode, moved: PanelRef, side: DockSide): LayoutNode => ({
  kind: 'split',
  dir: axisOf(side),
  sizes: [1, 1], // even halves
  children: side === 'left' || side === 'top' ? [moved, target] : [target, moved],
});
/** Share for a panel docked beside a content-sized one: the split's mean share, or a lone unit share. */
const meanShare = (sizes: SplitSize[]): number => {
  const nums = sizes.filter((s): s is number => s !== 'auto');
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 1;
};
/** The target panel itself, or the tab group showing it (docking beside a tab docks beside its group). */
const holds = (node: LayoutNode, id: LayoutPanelId): boolean =>
  node.kind === 'panel' ? node.id === id : node.kind === 'tabs' && node.children.some((c) => c.id === id);

/** Inserts moved beside target, halving target shares in matching splits or creating a two-way split. Content-sized targets receive mean shares. */
function dock(node: LayoutNode, moved: PanelRef, target: LayoutPanelId, side: DockSide): LayoutNode {
  if (holds(node, target)) return pair(node, moved, side);
  if (node.kind !== 'split') return node;
  const i = node.children.findIndex((c) => holds(c, target));
  if (i < 0) return { ...node, children: node.children.map((c) => dock(c, moved, target, side)) };
  const size = node.sizes[i]!;
  const sizes = [...node.sizes];
  const children = [...node.children];
  if (node.dir === axisOf(side)) {
    const [kept, added] = size === 'auto' ? ['auto' as const, meanShare(sizes)] : [size / 2, size / 2];
    sizes[i] = kept;
    const at = side === 'left' || side === 'top' ? i : i + 1;
    sizes.splice(at, 0, added);
    children.splice(at, 0, moved);
  } else {
    sizes[i] = size === 'auto' ? meanShare(sizes) : size;
    children[i] = pair(children[i]!, moved, side);
  }
  return { ...node, sizes, children };
}

/** Moves/adds panels beside targets. Missing targets or self-moves return the original root. */
export function movePanel(root: LayoutNode, id: LayoutPanelId, target: LayoutPanelId, side: DockSide): LayoutNode {
  const ids = panelIds(root);
  if (id === target || !ids.includes(target)) return root;
  const rest = ids.includes(id) ? removePanel(root, id) : root;
  return rest ? dock(rest, { kind: 'panel', id }, target, side) : root;
}
