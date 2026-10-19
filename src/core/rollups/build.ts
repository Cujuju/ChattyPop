import type { Db } from '../db';

/** Build coverage is finite; newer dirty/reference/span work belongs to maintenance. */
export function installRollupBuilds(db: Db): void {
  db.transaction(() => {
    const installed = db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'rollup_build_parts'").get();
    db.exec(`CREATE TABLE IF NOT EXISTS rollup_build_parts (
      rollup TEXT NOT NULL, channel_id TEXT NOT NULL, day TEXT NOT NULL,
      PRIMARY KEY(rollup, channel_id, day))`);
    if (!installed) {
      // Resume round-two builds from their remaining work without enumerating the archive again.
      db.exec(`INSERT OR IGNORE INTO rollup_build_parts
        SELECT d.rollup, d.channel_id, d.day FROM rollup_dirty d JOIN rollup_meta m USING(rollup)
        WHERE m.full_build = 1 AND m.backfill = 0`);
      db.exec(`UPDATE rollup_meta SET full_build = backfill WHERE full_build = 1
        AND NOT EXISTS (SELECT 1 FROM rollup_build_parts b WHERE b.rollup = rollup_meta.rollup)`);
    }
  })();
}

export function finishRollupBuild(db: Db, id: string): void {
  db.prepare(`UPDATE rollup_meta SET full_build = 0 WHERE rollup = ? AND backfill = 0
    AND NOT EXISTS (SELECT 1 FROM rollup_build_parts WHERE rollup = ?)`).run(id, id);
}

export function acknowledgeBuildPart(db: Db, id: string, channel: string, day: string): void {
  db.prepare('DELETE FROM rollup_build_parts WHERE rollup = ? AND channel_id = ? AND day = ?').run(id, channel, day);
  finishRollupBuild(db, id);
}
