/** Normalizes bare/versioned READY lists. Missing lists are partial, so omission never closes or clears stored entries. */
export function entriesOf<T>(v: unknown): { entries: T[]; partial: boolean } {
  if (Array.isArray(v)) return { entries: v as T[], partial: false };
  if (v === null || typeof v !== 'object') return { entries: [], partial: true };
  const o = v as { entries?: T[]; partial?: boolean };
  return { entries: o.entries ?? [], partial: o.partial === true };
}
