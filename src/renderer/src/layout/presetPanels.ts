// Declared plugin panels inserted into preset containers before availability pruning.
import { placeByAnchor } from '@shared/anchors';
import type { PanelDecl } from '@shared/bundledTypes';
import type { LayoutNode, PanelRef, SplitSize } from './types';

/** Inserts declared panels beside their anchors, retaining the preset's original split shares. */
export function placePresetPanels(root: LayoutNode, preset: string, panels: readonly PanelDecl[]): LayoutNode {
  const extra = panels.flatMap((panel) => (panel.presets ?? []).filter((p) => p.id === preset).map((p) => ({
    ...p,
    id: panel.id,
    node: { kind: 'panel', id: panel.id } as PanelRef,
    size: p.size ?? 1,
  })));
  const declarations = new Map(extra.map((item) => [item.id, item]));
  const anchor = (id: string): string | undefined => {
    const seen = new Set<string>();
    let target = id;
    while (declarations.has(target)) {
      if (seen.has(target)) throw new Error(`Preset panel placement loops through ${target}`);
      seen.add(target);
      const item = declarations.get(target)!;
      target = item.before ?? item.after ?? '';
    }
    return target || undefined;
  };
  const visit = (node: LayoutNode): LayoutNode => {
    if (node.kind === 'panel') return node;
    const host = node.children.map((child, index) => ({
      id: child.kind === 'panel' ? child.id : `container:${index}`,
      node: visit(child),
      size: node.kind === 'split' ? node.sizes[index]! : 1 as SplitSize,
    }));
    const ids = new Set(node.children.flatMap((child) => child.kind === 'panel' ? [child.id] : []));
    const additions = extra.filter((item) => ids.has(anchor(item.id) ?? ''));
    const placed = placeByAnchor(host, additions, (item) => item.id, (id) => {
      const item = declarations.get(id);
      return item?.before ? { before: item.before } : item?.after;
    });
    if (node.kind === 'tabs') return { ...node, children: placed.map((item) => item.node as PanelRef) };
    return {
      ...node,
      children: placed.map((item) => item.node),
      sizes: placed.map((item) => item.size),
    };
  };
  return visit(root);
}
