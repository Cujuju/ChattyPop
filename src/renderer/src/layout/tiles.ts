import {
  appendTile, findSlot, insertTile, moveTab, removeTile, setActiveTab, setSlotCollapsed, tileIds,
  type TileNode, type TileSlot, type TileSplit,
} from '@cujuju/solidjs-tiling-window-manager';

/** Projects inactive owners without changing the persisted tree. */
export function shownTree(root: TileNode, hidden: ReadonlySet<string>): TileNode | undefined {
  let shown: TileNode | undefined = root;
  for (const id of hidden) {
    const slot = findSlot(shown, id)?.slot;
    if (shown && slot && tileIds(slot).every((member) => hidden.has(member))) shown = setSlotCollapsed(shown, id, null);
    shown = removeTile(shown, id);
  }
  return shown;
}

/** Reconciles edits whose visible split topology is unchanged, including entirely hidden subtrees. */
function restoreInPlace(stored: TileNode, next: TileNode | undefined, hidden: ReadonlySet<string>): TileNode | undefined {
  const visibleIds = tileIds(stored).filter((id) => !hidden.has(id));
  if (!visibleIds.length) return next ? undefined : stored;
  const nextIds = tileIds(next);
  if (!next || visibleIds.length !== nextIds.length || visibleIds.some((id, i) => id !== nextIds[i])) return undefined;
  if (!tileIds(stored).some((id) => hidden.has(id))) return next;
  if (stored.kind === 'tabs') {
    if (next.kind === 'split') return undefined;
    const shownActive = next.kind === 'tabs' ? next.children[next.active]!.id : next.id;
    const storedActive = stored.children[stored.active]!.id;
    const projected = shownTree(stored, hidden);
    const projectedActive = projected?.kind === 'tabs' ? projected.children[projected.active]!.id
      : projected?.kind === 'tile' ? projected.id : undefined;
    const activeId = hidden.has(storedActive) && shownActive === projectedActive ? storedActive : shownActive;
    return { ...stored, ...('collapsed' in next ? { collapsed: next.collapsed } : { collapsed: undefined }),
      active: stored.children.findIndex((child) => child.id === activeId) };
  }
  if (stored.kind !== 'split') return next;
  const visible = stored.children.map((child, index) => ({ child, index, ids: tileIds(child).filter((id) => !hidden.has(id)) }))
    .filter(({ ids }) => ids.length);
  const only = visible.length === 1;
  if (!only && (next.kind !== 'split' || next.dir !== stored.dir || next.children.length !== visible.length)) return undefined;
  const children = [...stored.children];
  const sizes = [...stored.sizes];
  const storedTotal = visible.reduce((sum, { index }) => sum + stored.sizes[index]!, 0);
  const nextTotal = next.kind === 'split' && !only ? next.sizes.reduce((a, b) => a + b, 0) : storedTotal;
  for (const [i, { child, index }] of visible.entries()) {
    const edited = only ? next : next.kind === 'split' ? next.children[i] : undefined;
    const restored = restoreInPlace(child, edited, hidden);
    if (!restored) return undefined;
    children[index] = restored;
    sizes[index] = next.kind === 'split' && !only ? next.sizes[i]! : stored.sizes[index]!;
  }
  stored.children.forEach((child, index) => {
    if (tileIds(child).every((id) => hidden.has(id))) sizes[index] = stored.sizes[index]! * nextTotal / storedTotal;
  });
  return { ...stored, children, sizes };
}

/** Restores hidden slots beside their surviving neighbours, using stored split proportions. */
export function restoreHidden(stored: TileNode, next: TileNode | undefined, hidden: ReadonlySet<string>): TileNode | undefined {
  const restored = restoreInPlace(stored, next, hidden);
  if (restored) return restored;
  let result = next;
  const restoreSlot = (slot: TileSlot, ancestors: { split: TileSplit; index: number }[]): void => {
    const missing = tileIds(slot).filter((id) => hidden.has(id) && !tileIds(result).includes(id));
    for (const id of missing) {
      const tabAnchor = tileIds(slot).find((other) => tileIds(result).includes(other));
      if (slot.kind === 'tabs' && tabAnchor && result) {
        result = insertTile(result, id, tabAnchor, 'center');
        const order = tileIds(slot).filter((other) => tileIds(result).includes(other));
        order.forEach((other, i) => { result = moveTab(result!, other, i); });
        const activeId = slot.children[slot.active]!.id;
        const group = findSlot(result, id)!.slot;
        if (group.kind === 'tabs') result = setActiveTab(result, id, Math.max(0, group.children.findIndex((child) => child.id === activeId)));
        continue;
      }
      let inserted = false;
      for (const { split, index } of [...ancestors].reverse()) {
        const present = tileIds(result);
        const candidates = split.children.map((child, i) => ({ child, i }))
          .filter(({ i, child }) => i !== index && tileIds(child).some((other) => present.includes(other)))
          .sort((a, b) => Math.abs(a.i - index) - Math.abs(b.i - index));
        const neighbour = candidates[0];
        if (!neighbour || !result) continue;
        const target = tileIds(neighbour.child).find((other) => present.includes(other))!;
        const location = findSlot(result, target)!;
        const matching = location.parent?.dir === split.dir;
        const represented = split.children.reduce((sum, child, i) => sum + (tileIds(child).some((other) => present.includes(other)) ? split.sizes[i]! : 0), 0);
        const currentTotal = matching ? location.parent!.sizes.reduce((a, b) => a + b, 0) : split.sizes[neighbour.i]!;
        const scale = currentTotal / (matching ? represented : split.sizes[neighbour.i]!);
        const targetShare = matching ? location.parent!.sizes[location.index]! : split.sizes[neighbour.i]! * scale;
        const side = split.dir === 'row' ? (index < neighbour.i ? 'left' : 'right') : (index < neighbour.i ? 'top' : 'bottom');
        result = insertTile(result, id, target, side, [targetShare, split.sizes[index]! * scale]);
        inserted = true;
        break;
      }
      if (!inserted) result = appendTile(result, id);
      if (slot.collapsed && result) result = setSlotCollapsed(result, id, slot.collapsed.edge);
    }
  };
  const visit = (node: TileNode, ancestors: { split: TileSplit; index: number }[]): void => {
    if (node.kind !== 'split') return restoreSlot(node, ancestors);
    node.children.forEach((child, index) => visit(child, [...ancestors, { split: node, index }]));
  };
  visit(stored, []);
  return result;
}
