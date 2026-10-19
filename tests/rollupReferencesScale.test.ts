import { expect, it, onTestFinished, vi } from 'vitest';
import { tempDb } from './helpers';
import { seedArchiveViews } from './archiveViewsFixture';
import { installRollupStore } from '../src/core/rollups/store';
import { seedRollupReferences } from '../src/core/rollups/privacy';
import * as readers from '../src/core/reads/archiveReads';

const MESSAGES = 200_000; // Exceeds the native argument-count limit and represents a substantial bootstrap.
it('classifies bootstrap in the worker and transfers only index mismatches', async () => {
  const db = tempDb(); seedArchiveViews(db); installRollupStore(db);
  onTestFinished(() => { db.close(); });
  db.exec('DELETE FROM messages; DELETE FROM links');
  db.prepare(`WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM numbers WHERE n < ?)
    INSERT INTO messages(id, channel_id, author_id, ts, content) SELECT 'bulk-' || n, 'c-open', 'u', n, 'ordinary prose' FROM numbers`).run(MESSAGES);
  db.exec("UPDATE messages SET content = '<#c-open>' WHERE id = 'bulk-1'; INSERT INTO rollup_reference_messages VALUES ('bulk-2')");
  let transferred = 0;
  const original = readers.readArchive;
  const spy = vi.spyOn(readers, 'readArchive').mockImplementation(async (...args) => {
    const rows = await original(...args); transferred += rows.length; return rows as never;
  });
  onTestFinished(() => spy.mockRestore());
  expect(await seedRollupReferences(db, new AbortController().signal)).toBe(true);
  expect(transferred).toBe(2);
  expect(db.prepare('SELECT message_id FROM rollup_reference_messages').pluck().all()).toEqual(['bulk-1']);
  expect(db.prepare('SELECT * FROM rollup_reference_pending').all()).toEqual([]);
  expect(db.prepare('SELECT ready FROM rollup_reference_state').pluck().get()).toBe(1);
});

it('retains a queued edit made after worker classification until the next drain', async () => {
  const db = tempDb(); seedArchiveViews(db); installRollupStore(db);
  onTestFinished(() => { db.close(); });
  db.exec("DELETE FROM messages; DELETE FROM links; INSERT INTO messages(id, channel_id, author_id, ts, content) VALUES ('race', 'c-open', 'u', 0, 'ordinary')");
  let changed = false;
  const original = readers.readArchive;
  const spy = vi.spyOn(readers, 'readArchive').mockImplementation(async (...args) => {
    const rows = await original(...args);
    if (!changed) { changed = true; db.exec("UPDATE messages SET content = '<#c-open>' WHERE id = 'race'"); }
    return rows as never;
  });
  onTestFinished(() => spy.mockRestore());
  expect(await seedRollupReferences(db, new AbortController().signal)).toBe(false);
  expect(db.prepare('SELECT id FROM rollup_reference_pending').pluck().all()).toEqual(['race']);
  expect(await seedRollupReferences(db, new AbortController().signal)).toBe(true);
  expect(db.prepare('SELECT message_id FROM rollup_reference_messages').pluck().all()).toEqual(['race']);
});
