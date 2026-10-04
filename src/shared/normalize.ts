// Readers for stored JSON: each returns the value when it is valid, else the fallback.

/** A non-null object whose fields can be read. */
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** `v` when it is one of `all`, else `fallback`. */
export const oneOf = <T extends string, F = T>(all: readonly T[], v: unknown, fallback: F): T | F => (all.includes(v as T) ? (v as T) : fallback);

export const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

/** `v` as a number, rounded and clamped to [min, max]; unreadable (NaN) = `fallback`. Number(null) is 0, so null clamps to `min`. */
export const clampInt = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

/** `v` as a number clamped to [min, max], not rounded; not a finite number = `fallback`. */
export const clampNumber = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

/** Normalizer: a finite number, else `fallback`. */
export const finiteOr =
  <F>(fallback: F) =>
  (v: unknown): number | F =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/** Normalizer: an array's strings, else `fallback`. */
export const stringsOr =
  <F>(fallback: F) =>
  (v: unknown): string[] | F =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : fallback;

/** Normalizer: an array's integers, else `fallback`. */
export const integersOr =
  <F>(fallback: F) =>
  (v: unknown): number[] | F =>
    Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : fallback;

/** Normalizer: an object's entries whose value passes `isT` (and key passes `keyOk`), else {}. */
export const recordOf =
  <T>(isT: (v: unknown) => v is T, keyOk: (key: string) => boolean = () => true) =>
  (v: unknown): Record<string, T> =>
    v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter((e): e is [string, T] => keyOk(e[0]) && isT(e[1]))) : {};

/** A non-empty string, trimmed unless `trim` is false (then only '' is empty); else null. */
export const textOrNull = (v: unknown, trim = true): string | null => {
  if (typeof v !== 'string') return null;
  const s = trim ? v.trim() : v;
  return s ? s : null;
};
