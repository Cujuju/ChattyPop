// Rows keyed by id: a <For> over the ids keeps each row (its element, focus) across reads that make new objects for the
// same ids, as every directory read does; each row reads its item by id, so it still shows the newest.
import { createMemo, type Accessor } from 'solid-js';

export interface KeyedRows<T> {
  ids: Accessor<string[]>;
  item: (id: string) => T | undefined;
}

export function keyedRows<T extends { id: string }>(list: Accessor<readonly T[]>): KeyedRows<T> {
  const byId = createMemo(() => new Map(list().map((x) => [x.id, x])));
  return { ids: () => list().map((x) => x.id), item: (id) => byId().get(id) };
}
