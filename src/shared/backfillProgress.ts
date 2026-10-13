/** Fraction of the requested history reached; a channel cannot have messages older than its creation. */
export function backfillFraction(now: number, cutoffMs: number, createdMs: number, reachedMs: number): number {
  const windowMs = now - Math.max(cutoffMs, createdMs);
  if (windowMs <= 0) return 1;
  return Math.min(1, Math.max(0, (now - reachedMs) / windowMs));
}

/** History page size observed from the Discord web client. */
export const HISTORY_PAGE_SIZE = 50;
/** Stored messages below this say too little about how busy a channel is. */
const MIN_MESSAGES_FOR_RATE = 2;

/** What a channel's stored range says about it (SyncState), with the times of its ends. */
export interface StoredRange {
  count: number;
  oldestMs: number | null;
  newestMs: number | null;
  backfillComplete: boolean;
}

/**
 * History pages a backfill to `cutoffMs` would fetch, assuming the channel was as busy before its stored range as within it.
 * 0 when nothing is left to fetch; null when too little is stored to tell.
 */
export function estimateBackfillPages(stored: StoredRange, cutoffMs: number, createdMs: number): number | null {
  if (stored.backfillComplete) return 0;
  if (stored.oldestMs === null || stored.newestMs === null) return null;
  const leftMs = stored.oldestMs - Math.max(cutoffMs, createdMs);
  if (leftMs <= 0) return 0;
  const storedMs = stored.newestMs - stored.oldestMs;
  if (stored.count < MIN_MESSAGES_FOR_RATE || storedMs <= 0) return null;
  return Math.ceil(((stored.count / storedMs) * leftMs) / HISTORY_PAGE_SIZE);
}
