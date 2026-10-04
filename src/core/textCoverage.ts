// Archive time spans active owners cover, checked before message text is removed.
import type { Db } from './db';

/** Archive time an owner covers in some channels (e.g. a summary's sources), both ends inclusive. */
export interface CoverageSpan {
  channelIds: readonly string[];
  since: number;
  until: number;
}

const providers = new Set<() => readonly CoverageSpan[]>();

/** Registers an owner's covered spans until disposal. */
export function registerTextCoverage(read: () => readonly CoverageSpan[]): () => void {
  providers.add(read);
  return () => {
    providers.delete(read);
  };
}

/** Message alias `m` falls in a span loaded by loadTextCoverage. */
export const TEXT_COVERED_SQL = `EXISTS (SELECT 1 FROM temp.text_coverage c
  WHERE c.channel_id = m.channel_id AND m.ts >= c.since_ts AND m.ts <= c.until_ts)`;

/**
 * Loads every active owner's spans into temp.text_coverage, replacing earlier ones, so TEXT_COVERED_SQL reads the current
 * coverage. The host builds the SQL; owners supply data only. No owner: nothing is covered.
 */
export function loadTextCoverage(db: Db): void {
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS text_coverage (channel_id TEXT NOT NULL, since_ts INTEGER NOT NULL, until_ts INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS temp.text_coverage_channel ON text_coverage(channel_id, since_ts)`);
  const insert = db.prepare('INSERT INTO temp.text_coverage (channel_id, since_ts, until_ts) VALUES (?, ?, ?)');
  const spans = [...providers].flatMap((read) => read());
  db.transaction(() => {
    db.exec('DELETE FROM temp.text_coverage');
    for (const s of spans) for (const channelId of s.channelIds) insert.run(channelId, s.since, s.until);
  })();
}
