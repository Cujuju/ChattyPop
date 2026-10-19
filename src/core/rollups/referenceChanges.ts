import { MS_PER_S } from '@shared/units';
import type { Db } from '../db';

const ACKNOWLEDGE_BATCH = 128; // Bound committed queue cleanup independently of archive size.

export function installReferenceChanges(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS rollup_reference_changes (
    kind TEXT NOT NULL, channel_id TEXT NOT NULL, day TEXT NOT NULL, revision INTEGER NOT NULL,
    PRIMARY KEY(kind, channel_id, day));
    CREATE INDEX IF NOT EXISTS rollup_reference_changes_revision ON rollup_reference_changes(revision)`);
}

/** Range joins use the archive's channel/time indexes, including reverse backfills. */
export const referencePartitionSql = (table: string, kind: string, channel: string, ts: string): string =>
  `SELECT t.id FROM rollup_reference_changes p CROSS JOIN ${table} t
    ON t.${channel} = p.channel_id AND t.${ts} >= unixepoch(p.day) * ${MS_PER_S}
      AND t.${ts} < unixepoch(p.day, '+1 day') * ${MS_PER_S} WHERE p.kind = '${kind}'`;

export async function acknowledgeReferenceChanges(db: Db, epoch: number, signal: AbortSignal): Promise<void> {
  const remove = db.prepare(`DELETE FROM rollup_reference_changes WHERE rowid IN (
    SELECT rowid FROM rollup_reference_changes WHERE revision <= ? LIMIT ?)`);
  while (remove.run(epoch, ACKNOWLEDGE_BATCH).changes) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    signal.throwIfAborted();
  }
}
