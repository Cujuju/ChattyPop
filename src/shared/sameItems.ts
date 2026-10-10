// Reloaded lists that keep their unchanged items' identity, for views that key rows by it.

/**
 * `next`, with each item equal to `prev`'s item of the same id replaced by that one, so a reload hands a view its
 * unchanged items back. Equal: the same JSON, as both lists came over the wire.
 */
export function keepUnchanged<T extends { id: string }>(prev: readonly T[] | undefined, next: T[]): T[] {
  if (!prev?.length) return next;
  const byId = new Map(prev.map((item) => [item.id, item]));
  return next.map((item) => {
    const was = byId.get(item.id);
    return was && JSON.stringify(was) === JSON.stringify(item) ? was : item;
  });
}
