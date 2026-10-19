import type { IngestResult } from '@shared/contract';
import type { RawMessage } from '@shared/discord';

export const INGEST_MAX_ROWS = 16; // A 1.7 s history page of 100 rows becomes at least seven committed turns.
const INGEST_TARGET_MS = 50; // Leave a twentyfold margin below the one-second stall threshold.

/** Each callback commits a complete step; no SQLite transaction survives an event-loop yield. */
export async function ingestInTurns(
  messages: RawMessage[],
  write: (batch: RawMessage[], last: boolean) => IngestResult | null,
): Promise<IngestResult | null> {
  const total: IngestResult = { inserted: 0, edited: 0, skipped: 0 };
  let limit = INGEST_MAX_ROWS;
  let offset = 0;
  do {
    const batch = messages.slice(offset, offset + limit);
    const started = performance.now();
    const result = write(batch, offset + batch.length >= messages.length);
    if (!result) return null;
    total.inserted += result.inserted; total.edited += result.edited; total.skipped += result.skipped;
    offset += batch.length;
    limit = Math.max(1, Math.min(INGEST_MAX_ROWS, Math.floor(batch.length * INGEST_TARGET_MS / Math.max(1, performance.now() - started))));
    if (offset < messages.length) await new Promise<void>((resolve) => setImmediate(resolve));
  } while (offset < messages.length);
  return total;
}
