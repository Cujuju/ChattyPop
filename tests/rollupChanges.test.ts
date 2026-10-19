import { expect, it, onTestFinished } from 'vitest';
import { tempDb } from './helpers';
import { installRollupStore } from '../src/core/rollups/store';
import { installRollupTriggers } from '../src/core/rollups/triggers';
import { expandRollupChanges } from '../src/core/rollups/changes';
import { MS_PER_DAY } from '@shared/units';

const START = Date.UTC(2026, 0, 1);
const ROWS = 200; // Repeated rows in one partition must cost one shared mark, regardless of rollup count.

it('coalesces write marks and expands dependencies after the transaction', () => {
  const db = tempDb(); onTestFinished(() => { db.close(); });
  installRollupStore(db); installRollupTriggers(db);
  db.exec("INSERT INTO rollup_kinds VALUES ('a', 'messages'), ('b', 'messages'), ('c', 'attachments')");
  const insert = db.prepare("INSERT INTO messages(id, channel_id, author_id, ts, content) VALUES (?, 'channel', 'author', ?, '')");
  db.transaction(() => { for (let n = 0; n < ROWS; n++) insert.run(String(n), START + n); })();
  expect(db.prepare('SELECT * FROM rollup_changes').all()).toEqual([{ channel_id: 'channel', day: '2026-01-01', kind: 'messages' }]);
  expect(db.prepare('SELECT * FROM rollup_dirty').all()).toEqual([]);
  expect(expandRollupChanges(db)).toBe(true);
  expect(db.prepare('SELECT rollup, revision FROM rollup_dirty ORDER BY rollup').all()).toEqual([{ rollup: 'a', revision: 1 }, { rollup: 'b', revision: 1 }]);
  expect(expandRollupChanges(db)).toBe(false);
});

it('preserves both sides of moves and rolls shared marks back with writes', () => {
  const db = tempDb(); onTestFinished(() => { db.close(); });
  installRollupStore(db); installRollupTriggers(db);
  db.exec("INSERT INTO rollup_kinds VALUES ('a', 'messages'), ('a', 'edits'), ('a', 'deletes')");
  db.prepare("INSERT INTO messages(id, channel_id, author_id, ts, content) VALUES ('m', 'old', 'author', ?, '')").run(START);
  while (expandRollupChanges(db)) { /* Consume the original arrival. */ }
  db.exec('DELETE FROM rollup_dirty');
  expect(() => db.transaction(() => {
    db.exec("UPDATE messages SET channel_id = 'rolled-back' WHERE id = 'm'");
    throw new Error('rollback');
  })()).toThrow('rollback');
  expect(expandRollupChanges(db)).toBe(false);
  db.prepare("UPDATE messages SET channel_id = 'new', ts = ts + ? WHERE id = 'm'").run(MS_PER_DAY);
  while (expandRollupChanges(db)) { /* Expand the committed move. */ }
  expect(db.prepare('SELECT channel_id, day FROM rollup_dirty ORDER BY channel_id').all()).toEqual([
    { channel_id: 'new', day: '2026-01-02' }, { channel_id: 'old', day: '2026-01-01' },
  ]);
});

it('coalesces marks inside outer upserts without inheriting their conflict policy', () => {
  const db = tempDb(); onTestFinished(() => { db.close(); });
  installRollupStore(db); installRollupTriggers(db);
  const upsert = db.prepare(`INSERT INTO links(url, platform, first_message_id, first_channel_id, first_author_id, first_ts)
    VALUES ('https://example.test', 'web', 'message', 'channel', 'author', ?)
    ON CONFLICT(url) DO UPDATE SET first_ts = excluded.first_ts`);
  db.transaction(() => { upsert.run(START + 1); upsert.run(START); })();
  expect(db.prepare('SELECT * FROM rollup_changes').all()).toEqual([{ channel_id: 'channel', day: '2026-01-01', kind: 'links' }]);
});
