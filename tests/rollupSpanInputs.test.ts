import { expect, it, onTestFinished, vi } from 'vitest';
import { tempDb } from './helpers';
import { seedArchiveViews } from './archiveViewsFixture';
import { installRollupStore } from '../src/core/rollups/store';
import { installSpanTriggers } from '../src/core/rollups/spans';
import { seedSpanInputs, SPAN_PENDING_LAST_DAY } from '../src/core/rollups/spanInputs';
import * as readers from '../src/core/reads/archiveReads';
import { MS_PER_DAY } from '@shared/units';

const START = Date.UTC(2026, 0, 1);
const TABLE = 'p_probe_runs_v1';
const ID = 'probe.runs';
const SPAN = { start: 'first_ts', end: 'last_ts', paddingMs: 0 };

function fixture() {
  const db = tempDb(); seedArchiveViews(db); installRollupStore(db);
  db.exec(`CREATE TABLE ${TABLE}(channel_id TEXT, first_ts INTEGER, last_ts INTEGER)`);
  db.prepare(`INSERT INTO ${TABLE} VALUES (?, ?, ?)`).run('c-open', START, START + 2 * MS_PER_DAY);
  installSpanTriggers(db, ID, TABLE, { first_ts: 'INTEGER', last_ts: 'INTEGER' }, SPAN);
  onTestFinished(() => { db.close(); });
  return db;
}

it('retains an unqueued day arriving after the reader snapshot', async () => {
  const db = fixture();
  db.prepare('UPDATE messages SET ts = ? WHERE id = ?').run(START + MS_PER_DAY, 'm-open');
  let changed = false;
  const original = readers.readArchive;
  const spy = vi.spyOn(readers, 'readArchive').mockImplementation(async (...args) => {
    const rows = await original(...args);
    if (!changed) { changed = true; db.prepare('UPDATE messages SET ts = ? WHERE id = ?').run(START + 2 * MS_PER_DAY, 'm-open'); }
    return rows as never;
  });
  onTestFinished(() => spy.mockRestore());
  expect(await seedSpanInputs(db, ID, TABLE, SPAN, new AbortController().signal)).toBe(false);
  expect(db.prepare('SELECT COUNT(*) FROM rollup_span_inputs').pluck().get()).toBeGreaterThan(0);
  expect(db.prepare('SELECT last_day FROM rollup_span_dirty WHERE first_day = ?').pluck().get('')).toBe(SPAN_PENDING_LAST_DAY);
  expect(await seedSpanInputs(db, ID, TABLE, SPAN, new AbortController().signal)).toBe(true);
  expect(db.prepare('SELECT first_day, last_day FROM rollup_span_dirty').all()).toEqual([{ first_day: '2026-01-01', last_day: '2026-01-03' }]);
  expect(db.prepare('SELECT * FROM rollup_span_inputs').all()).toEqual([]);
});

it.each([[0, 1, 2], [2, 1, 0], [1, 0, 2]])('discovers the same stored overlap across reverse and mixed arrivals %j', async (...days) => {
  const db = fixture();
  const insert = db.prepare('INSERT INTO messages(id, channel_id, author_id, ts, content) VALUES (?, ?, ?, ?, ?)');
  for (const day of days) insert.run(`input-${day}`, 'c-open', 'u', START + day * MS_PER_DAY, 'arrived');
  expect(await seedSpanInputs(db, ID, TABLE, SPAN, new AbortController().signal)).toBe(true);
  expect(db.prepare('SELECT first_day, last_day FROM rollup_span_dirty').all()).toEqual([{ first_day: '2026-01-01', last_day: '2026-01-03' }]);
});

it('records one generation and one durable input for a thousand same-day messages', () => {
  const db = fixture();
  const arrivals = 1_000; // Catch-up volume must not multiply span writes within an already queued day.
  db.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < ?)
    INSERT INTO messages(id, channel_id, author_id, ts, content) SELECT 'same-day-' || i, 'c-open', 'u', ?, 'same day' FROM n`)
    .run(arrivals, START);
  expect(db.prepare('SELECT COUNT(*) FROM rollup_span_inputs').pluck().get()).toBe(1);
  expect(db.prepare('SELECT revision FROM rollup_span_generations WHERE rollup = ?').pluck().get(ID)).toBe(1);
  expect(db.prepare('SELECT COUNT(*) FROM rollup_span_dirty').pluck().get()).toBe(1);
});
