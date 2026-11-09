import type { LayoutNode, LayoutPanelId, SplitSize } from './types';

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
