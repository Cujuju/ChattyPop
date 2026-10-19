import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '@core/db';
import { installRollupStore } from '@core/rollups/store';
import { knownReferenceSql, seedRollupReferences } from '@core/rollups/privacy';
import { readArchive, closeArchiveReads } from '@core/reads/archiveReads';
import { setArchiveReadEntry } from '@core/reads/helperEntry';
import { MS_PER_DAY, MS_PER_S } from '@shared/units';

const ROWS = 400_000;
const CATALOG = 2_000; // A large multi-server catalog makes the old cross product measurable.
const DAYS = 390;
const LIVE_MS = MS_PER_S / 10;
const DIR_PREFIX = 'cp-reference-drain-';

export async function main() {
  setArchiveReadEntry(join(import.meta.dirname, '../../out/read-tests/archiveReadProcess.js'));
  const dir = mkdtempSync(join(tmpdir(), DIR_PREFIX));
  const db = openDb(join(dir, 'archive.db'));
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    installRollupStore(db);
    db.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO channels(id, name, kind) SELECT 'catalog-' || i, 'Synthetic channel', 0 FROM n`).run(CATALOG);
    db.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < @rows)
      INSERT INTO messages(id, channel_id, author_id, ts, content)
      SELECT 'stored-' || i, 'catalog-1', 'author', CAST(i * @days * @day / @rows AS INTEGER),
      CASE WHEN i % @period = 0 THEN 'a bare catalog-1999 substring' ELSE 'Ordinary synthetic prose with no reference.' END FROM n`)
      .run({ rows: ROWS, days: DAYS, day: MS_PER_DAY, period: DAYS });
    const measured = async (name: string, run: () => Promise<unknown>) => {
      const start = performance.now(), result = await run();
      console.log(JSON.stringify({ name, ms: performance.now() - start, result }));
    };
    console.log(JSON.stringify({ rows: ROWS, catalog: CATALOG, days: DAYS, liveMs: LIVE_MS }));
    const sql = `SELECT COUNT(*) AS n FROM messages WHERE ${knownReferenceSql('content')}`;
    await measured('legacy-full-classification', () => readArchive(db, sql, []));
    await measured('worker-full-classification', () => seedRollupReferences(db, new AbortController().signal));
    let inserted = 0;
    const insert = db.prepare('INSERT INTO messages(id, channel_id, author_id, ts, content) VALUES (?, ?, ?, ?, ?)');
    timer = setInterval(() => insert.run(`live-${++inserted}`, 'catalog-1', 'author', DAYS * MS_PER_DAY + inserted, 'live catalog-1999'), LIVE_MS);
    await new Promise((resolve) => setTimeout(resolve, LIVE_MS));
    db.prepare("UPDATE messages SET content = 'changed catalog-1999' WHERE ts >= ?").run((DAYS - 1) * MS_PER_DAY);
    const daySql = `${sql} AND channel_id = ? AND ts >= ?`;
    await measured('legacy-day-classification', () => readArchive(db, daySql, ['catalog-1', (DAYS - 1) * MS_PER_DAY]));
    await measured('worker-day-drain-with-live-inserts', () => seedRollupReferences(db, new AbortController().signal));
    clearInterval(timer); timer = undefined;
    await seedRollupReferences(db, new AbortController().signal);
    const actual = db.prepare('SELECT COUNT(*) FROM rollup_reference_messages').pluck().get();
    const expected = db.prepare(`SELECT COUNT(*) FROM messages WHERE instr(content, 'catalog-1999') > 0`).pluck().get();
    if (actual !== expected) throw new Error(`Reference mismatch: ${actual} != ${expected}`);
    console.log(JSON.stringify({ exact: true, references: actual, liveInserts: inserted }));
  } finally {
    clearInterval(timer); await closeArchiveReads(db); db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
