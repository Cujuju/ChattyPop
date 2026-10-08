/** Recent picks first, then archived usage; unused favorites retain their Discord order. */
export function rankEmojiFavorites<T>(favorites: T[], keyOf: (item: T) => string, recent: string[], frequent: string[]): T[] {
  const rank = (item: T): number => {
    const key = keyOf(item);
    const r = recent.indexOf(key);
    if (r >= 0) return r;
    const f = frequent.indexOf(key);
    return recent.length + (f >= 0 ? f : frequent.length);
  };
  return [...favorites].sort((a, b) => rank(a) - rank(b));
}
