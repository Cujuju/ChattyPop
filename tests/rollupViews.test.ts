import { expect, it, onTestFinished } from 'vitest';
import { tempDb } from './helpers';
import { installRollupStore, rollupTable } from '../src/core/rollups/store';

const ID = 'viewprobe.counts';
const DAYS = ['2026-01-01', '2026-01-02'];
const KEYS = 1_000; // Many aggregate keys share each eligibility decision.

it('retains indexed scopes while excluding pending and hidden partitions', () => {
  const db = tempDb(); onTestFinished(() => { db.close(); }); installRollupStore(db);
  const table = rollupTable(db, 'viewprobe', 'counts', { version: 1, columns: { key: 'TEXT', n: 'INTEGER' }, key: ['key'],
    dependsOn: ['messages'], compute: async () => [], allTime: { values: { n: 'sum' } } });
  db.exec(`INSERT INTO rollup_meta(rollup, version, zone, backfill) VALUES ('${ID}', 1, 'UTC', 0);
    INSERT INTO rollup_kinds VALUES ('${ID}', 'messages'); UPDATE rollup_reference_state SET ready = 1;
    DELETE FROM rollup_reference_catalog;`);
  const row = db.prepare(`INSERT INTO ${table} VALUES ('channel', ?, ?, 1)`);
  db.transaction(() => {
    for (const day of DAYS) {
      db.prepare('INSERT INTO rollup_partitions VALUES (?, ?, ?, 0)').run(ID, 'channel', day);
      for (let n = 0; n < KEYS; n++) row.run(day, String(n));
    }
    db.prepare(`INSERT INTO ${table}_all_time VALUES ('channel', 'key', 2)`).run();
  })();
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT SUM(n) FROM ${table}_visible WHERE channel_id = ? AND day = ?`)
    .all('channel', DAYS[0]) as { detail: string }[];
  expect(plan.some(({ detail }) => detail.includes('SEARCH r') && detail.includes('channel_id=? AND day=?'))).toBe(true);
  expect(db.prepare(`SELECT SUM(n) FROM ${table}_visible`).pluck().get()).toBe(KEYS * DAYS.length);
  db.prepare('INSERT INTO rollup_changes VALUES (?, ?, ?)').run('channel', DAYS[0], 'messages');
  expect(db.prepare(`SELECT SUM(n) FROM ${table}_visible`).pluck().get()).toBe(KEYS);
  expect(db.prepare(`SELECT * FROM ${table}_all_time_visible`).all()).toEqual([]);
  db.exec("DELETE FROM rollup_changes; INSERT INTO hidden_ids VALUES ('channel', 'channel')");
  expect(db.prepare(`SELECT * FROM ${table}_visible`).all()).toEqual([]);
});
