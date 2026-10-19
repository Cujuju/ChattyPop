import { expect, it, onTestFinished } from 'vitest';
import { tempDb } from './helpers';
import { installRollupStore, rollupTable } from '../src/core/rollups/store';
import { markMaterializedFold, publishMaterializedFold } from '../src/core/rollups/materialized';

const ROW_BYTES = 768 * 1024; // Two rows exceed the one-MiB publication budget.

it('yields wide packets, hides interrupted publication and resumes the durable request', async () => {
  const db = tempDb(); onTestFinished(() => { db.close(); }); installRollupStore(db);
  const id = 'wide.rows', fold = { columns: { key: 'TEXT' as const, payload: 'TEXT' as const }, key: ['key'], compute: async () => [] };
  const table = rollupTable(db, 'wide', 'rows', { version: 1, columns: { key: 'TEXT' }, key: ['key'], dependsOn: ['messages'], compute: async () => [], fold });
  db.prepare('INSERT INTO rollup_meta(rollup, version, zone, backfill) VALUES (?, 1, ?, 0)').run(id, 'UTC');
  db.exec('UPDATE rollup_reference_state SET ready = 1; DELETE FROM rollup_reference_catalog');
  markMaterializedFold(db, id, 'channel');
  const rows = ['first', 'second'].map((key) => ({ key, payload: 'x'.repeat(ROW_BYTES) }));
  let current = true;
  setImmediate(() => { current = false; });
  expect(await publishMaterializedFold(db, id, table, fold, 'channel', 1, rows, () => current)).toBe(false);
  expect(db.prepare(`SELECT COUNT(*) FROM ${table}_folded`).pluck().get()).toBe(1);
  expect(db.prepare(`SELECT * FROM ${table}_folded_visible`).all()).toEqual([]);
  expect(db.prepare('SELECT COUNT(*) FROM rollup_fold_dirty').pluck().get()).toBe(1);
  expect(await publishMaterializedFold(db, id, table, fold, 'channel', 1, rows, () => true)).toBe(true);
  expect(db.prepare(`SELECT COUNT(*) FROM ${table}_folded_visible`).pluck().get()).toBe(rows.length);
});
