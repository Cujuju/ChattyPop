/** Fraction of the requested history reached; a channel cannot have messages older than its creation. */
export function backfillFraction(now: number, cutoffMs: number, createdMs: number, reachedMs: number): number {
  const windowMs = now - Math.max(cutoffMs, createdMs);
  if (windowMs <= 0) return 1;
  return Math.min(1, Math.max(0, (now - reachedMs) / windowMs));
}
