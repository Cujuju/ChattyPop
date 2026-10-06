// Keys For rows by id to preserve elements/focus across object refreshes. Each row resolves current item values by id.
import { createMemo, type Accessor } from 'solid-js';

export interface KeyedRows<T> {
  ids: Accessor<string[]>;
  item: (id: string) => T | undefined;
}

export function keyedRows<T extends { id: string }>(list: Accessor<readonly T[]>): KeyedRows<T> {
  const byId = createMemo(() => new Map(list().map((x) => [x.id, x])));
  return { ids: () => list().map((x) => x.id), item: (id) => byId().get(id) };
}
