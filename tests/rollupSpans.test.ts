import { expect, it } from 'vitest';
import { tempDb } from './helpers';
import { seedArchiveViews } from './archiveViewsFixture';
import { installRollupStore } from '../src/core/rollups/store';
import { installSpanTriggers } from '../src/core/rollups/spans';
import { MS_PER_DAY } from '@plugin-sdk/shared';

const START = Date.UTC(2026, 0, 1);
const SPAN_DAYS = 3; // A three-day run exposes opener dependencies on both sides of a changed middle day.

it('durably dirties every possible split opener in a stored run', () => {
  const db = tempDb(); seedArchiveViews(db); installRollupStore(db);
  const table = 'p_rollupprobe_runs_v1';
  db.exec(`CREATE TABLE ${table}(channel_id TEXT, first_ts INTEGER, last_ts INTEGER)`);
  db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?)`).run('c-open', START, START + (SPAN_DAYS - 1) * MS_PER_DAY);
  installSpanTriggers(db, 'rollupprobe.runs', table, { first_ts: 'INTEGER', last_ts: 'INTEGER' }, { start: 'first_ts', end: 'last_ts', paddingMs: 0 });
  db.prepare('UPDATE messages SET ts = ? WHERE id = ?').run(START + MS_PER_DAY, 'm-open');
  expect(db.prepare('SELECT first_day, last_day FROM rollup_span_dirty').all()).toEqual([{ first_day: '2026-01-01', last_day: '2026-01-03' }]);
  expect(db.prepare('SELECT * FROM rollup_dirty').all()).toEqual([]);
  expect(() => installSpanTriggers(db, 'rollupprobe.runs', table, {}, { start: 'missing', end: 'missing', paddingMs: -1 })).toThrow('Invalid rollup span');
});
