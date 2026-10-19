/** Equal keys in one turn share a read; a later invalidation always starts another. */
export function coalescedRead<A extends unknown[], T>(read: (...args: A) => Promise<T>, key: NoInfer<(...args: A) => string>): (...args: A) => Promise<T> {
  let current: { key: string; result: Promise<T>; signals: AbortSignal[] } | undefined;
  return (...args) => {
    const id = key(...args);
    const signals = args.filter((arg): arg is A[number] & AbortSignal => arg instanceof AbortSignal);
    if (current?.key === id && current.signals.length === signals.length && signals.every((signal, i) => current!.signals[i] === signal)) return current.result;
    const mine = { key: id, result: read(...args), signals };
    current = mine;
    queueMicrotask(() => { if (current === mine) current = undefined; });
    return mine.result;
  };
}
