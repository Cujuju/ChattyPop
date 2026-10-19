/** Equal keys in one turn share a read; a later invalidation always starts another. */
export function coalescedRead<A extends unknown[], T>(read: (...args: A) => Promise<T>, key: (...args: A) => string): (...args: A) => Promise<T> {
  let current: { key: string; result: Promise<T> } | undefined;
  return (...args) => {
    const id = key(...args);
    if (current?.key === id) return current.result;
    const mine = { key: id, result: read(...args) };
    current = mine;
    queueMicrotask(() => { if (current === mine) current = undefined; });
    return mine.result;
  };
}
