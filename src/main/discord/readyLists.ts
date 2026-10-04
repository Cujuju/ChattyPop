/**
 * READY sends some lists bare and some versioned ({ entries, partial }), by the client's gateway capabilities. A list
 * READY leaves out says nothing of what it holds: it reads as partial, so nothing is closed or cleared for it.
 */
export function entriesOf<T>(v: unknown): { entries: T[]; partial: boolean } {
  if (Array.isArray(v)) return { entries: v as T[], partial: false };
  if (v === null || typeof v !== 'object') return { entries: [], partial: true };
  const o = v as { entries?: T[]; partial?: boolean };
  return { entries: o.entries ?? [], partial: o.partial === true };
}
