// A displayed layout projects stored splits without losing hidden panels or their fractions.
import { isPluginPanelId, pluginOfPanelId, type PluginInfo } from '@shared/plugins';
import { bakeSizes, childPath } from './tree';
import type { LayoutNode, SplitSize } from './types';

/** Known inactive owners hide their panels; removed owners leave ids available for the missing-panel placeholder. */
export function panelOwnerOff(
  id: string,
  bundledOwner: (id: string) => string | undefined,
  active: (id: string) => boolean,
  plugins: readonly Pick<PluginInfo, 'id' | 'bundled' | 'conflict' | 'status'>[],
): boolean {
  const owner = bundledOwner(id);
  if (owner) return !active(owner);
  if (!isPluginPanelId(id)) return false;
  const folder = plugins.find((p) => !p.bundled && !p.conflict && p.id === pluginOfPanelId(id));
  return !!folder && folder.status !== 'active';
}

interface SplitOrigin {
  path: string;
  indices: number[];
  sizes: SplitSize[];
}

/** The displayed tree and its surviving splits' locations in the stored tree. */
export interface LayoutProjection {
  root: LayoutNode | null;
  splits: Record<string, SplitOrigin>;
}

/** Filters panels and collapses empty/single splits, preserving tab selection and mapping displayed paths to stored paths. */
export function projectLayout(root: LayoutNode, hidden: (id: string) => boolean): LayoutProjection {
  const origins = new Map<LayoutNode, SplitOrigin>();
  const visit = (node: LayoutNode, path: string): LayoutNode | null => {
    if (node.kind === 'panel') return hidden(node.id) ? null : node;
    if (node.kind === 'tabs') {
      const children = node.children.filter((c) => !hidden(c.id));
      if (!children.length) return null;
      // Unchanged nodes keep their identity, so keyed rendering doesn't remount them.
      if (children.length === node.children.length) return node;
      const active = Math.max(0, children.indexOf(node.children[node.active]!));
      return { ...node, children, active };
    }
    const kept = node.children.flatMap((c, i) => {
      const child = visit(c, childPath(path, i));
      return child ? [{ child, i }] : [];
    });
    if (!kept.length) return null;
    if (kept.length === 1) return kept[0]!.child;
    const unchanged = kept.length === node.children.length && kept.every((k) => k.child === node.children[k.i]);
    const shown = unchanged ? node : { ...node, children: kept.map((k) => k.child), sizes: kept.map((k) => node.sizes[k.i]!) };
    origins.set(shown, { path, indices: kept.map((k) => k.i), sizes: node.sizes });
    return shown;
  };
  const shown = visit(root, '');
  const splits: LayoutProjection['splits'] = {};
  const locate = (node: LayoutNode, path: string): void => {
    if (node.kind !== 'split') return;
    splits[path] = origins.get(node)!;
    node.children.forEach((c, i) => locate(c, childPath(path, i)));
  };
  if (shown) locate(shown, '');
  return { root: shown, splits };
}

/** Maps resized visible fractions to stored children, retaining hidden shares and the visible children's total weight. */
export function projectedSizes(projection: LayoutProjection, path: string, fractions: number[]): { path: string; sizes: number[] } | null {
  const origin = projection.splits[path];
  if (!origin) return null;
  const indices = origin.indices.filter((i) => origin.sizes[i] !== 'auto');
  if (indices.length !== fractions.length || fractions.some((n) => !Number.isFinite(n) || n <= 0)) return null;
  const weight = indices.reduce((sum, i) => sum + (origin.sizes[i] as number), 0);
  const total = fractions.reduce((sum, n) => sum + n, 0);
  const sizes = [...origin.sizes];
  indices.forEach((i, k) => { sizes[i] = fractions[k]! * weight / total; });
  return { path: origin.path, sizes: sizes.filter((s): s is number => s !== 'auto') };
}

/** Bakes stored-path overrides before editing the full tree, including every hidden panel. */
export function editStoredLayout(root: LayoutNode, sizes: Record<string, number[]> | undefined, edit: (root: LayoutNode) => LayoutNode | null): LayoutNode | null {
  const baked = bakeSizes(root, sizes);
  const edited = edit(baked);
  return edited === baked ? null : edited;
}
