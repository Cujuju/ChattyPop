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
