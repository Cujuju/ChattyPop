import type { Db } from '../db';

const EXPAND_BATCH_SIZE = 128; // Bound Core's dirty-row fan-out and yield between batches.

export function installRollupChanges(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS rollup_kinds (rollup TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (rollup, kind));
    CREATE TABLE IF NOT EXISTS rollup_changes (
      channel_id TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY(channel_id, day, kind));`);
}

/** An unexpanded mark is already dirty, including while a helper computes an older snapshot. */
export const pendingChangesSql = (rollup: string, channel?: string, day?: string, first?: string, channels?: string): string => `EXISTS (
  SELECT 1 FROM rollup_changes c JOIN rollup_kinds k ON k.kind = c.kind WHERE k.rollup = ${rollup}
    ${channel ? `AND c.channel_id = ${channel}` : ''} ${day ? `AND c.day = ${day}` : ''}
    ${first ? `AND (${first} IS NULL OR c.day >= ${first})` : ''}
    ${channels ? `AND (${channels} IS NULL OR c.channel_id IN (SELECT value FROM json_each(${channels})))` : ''})`;

/** Expansion and acknowledgement share a writer transaction; duplicate marks need no per-message revision update. */
export function expandRollupChanges(db: Db): boolean {
  const rows = db.prepare('SELECT channel_id, day, kind FROM rollup_changes LIMIT ?').all(EXPAND_BATCH_SIZE) as { channel_id: string; day: string; kind: string }[];
  if (!rows.length) return false;
  const mark = db.prepare(`INSERT INTO rollup_dirty(rollup, channel_id, day)
    SELECT rollup, ?, ? FROM rollup_kinds WHERE kind = ?
    ON CONFLICT(rollup, channel_id, day) DO UPDATE SET revision = revision + 1`);
  const remove = db.prepare('DELETE FROM rollup_changes WHERE channel_id = ? AND day = ? AND kind = ?');
  db.transaction(() => {
    for (const row of rows) {
      mark.run(row.channel_id, row.day, row.kind);
      remove.run(row.channel_id, row.day, row.kind);
    }
  })();
  return true;
}

export async function seedRollupChanges(db: Db, signal: AbortSignal): Promise<void> {
  while (expandRollupChanges(db)) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    signal.throwIfAborted();
  }
}
