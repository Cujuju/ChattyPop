import { expect, it } from 'vitest';
import { installRollupStore, markPartitions, replacePartition, rollupTable } from '../src/core/rollups/store';
import { tempDb } from './helpers';

const CHANNEL = 'channel';
const DAY = '2026-01-01';
const NEXT_DAY = '2026-01-02';
const ID = 'publication.counts';

it('publishes empty folds and retains unchanged all-time keys while removing disappeared ones', () => {
  const db = tempDb();
  installRollupStore(db);
  const table = rollupTable(db, 'publication', 'counts', {
    version: 1, columns: { bucket: 'TEXT', n: 'INTEGER' }, key: ['bucket'], dependsOn: ['messages'],
    allTime: { values: { n: 'sum' } }, compute: async () => [],
  });
  db.prepare('INSERT INTO rollup_meta(rollup, version, zone) VALUES (?, 1, ?)').run(ID, 'UTC');
  const publish = (day: string, rows: { bucket: string; n: number }[], keys = rows.map(({ bucket }) => ({ bucket }))) => {
    markPartitions(db, ID, [{ channel_id: CHANNEL, day }]);
    replacePartition(db, ID, table, { channel_id: CHANNEL, day, revision: 1 }, ['bucket', 'n'], rows, 0, { keys, rows });
  };
  publish(DAY, [{ bucket: 'kept', n: 1 }, { bucket: 'gone', n: 2 }]);
  publish(NEXT_DAY, []);
  expect(db.prepare('SELECT 1 FROM rollup_dirty WHERE rollup = ?').get(ID)).toBeUndefined();
  db.exec(`CREATE TEMP TABLE folded_updates(bucket TEXT);
    CREATE TEMP TRIGGER folded_update AFTER UPDATE ON "${table}_all_time"
      BEGIN INSERT INTO folded_updates VALUES (NEW.bucket); END;`);
  publish(DAY, [{ bucket: 'kept', n: 1 }], [{ bucket: 'kept' }, { bucket: 'gone' }]);
  expect(db.prepare(`SELECT bucket, n FROM "${table}_all_time"`).all()).toEqual([{ bucket: 'kept', n: 1 }]);
  expect(db.prepare('SELECT * FROM folded_updates').all()).toEqual([]);
});
