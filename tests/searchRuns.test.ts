// Archive search off the core thread: the same hits as on core, and a caller's newer search cancels its older one.
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '../src/core/db';
import { searchMessages } from '../src/core/queries/search';
import { closeArchiveReads } from '../src/core/reads/archiveReads';
import { searchOffThread } from '../src/core/searchRuns';
import { ARRIVAL } from '../src/core/arrival';
import { rawMessage, seedArchive, tempDb } from './helpers';

let db: Db;
beforeEach(() => {
  db = tempDb();
  seedArchive(db, [{ id: 'c1', name: 'general' }]).ingestMessages(
    [rawMessage('c1', 1, 'alpha **one**'), rawMessage('c1', 2, 'alpha two', { author: { id: 'u2', username: 'bob', global_name: null } })],
    ARRIVAL.gateway,
  );
});
afterEach(async () => {
  await closeArchiveReads(db);
  if (db.open) db.close();
});

it('reads the same hits off the core thread as on it, with words and filters alone', async () => {
  for (const q of ['alpha', 'from:bob']) expect(await searchOffThread(db, q, 10, 'newest', 'w1')).toEqual(searchMessages(db, q, 10, 'newest'));
  expect(await searchOffThread(db, '   ', 10, 'newest', 'w1')).toEqual([]);
});

it("cancels a caller's older search when it searches again, and leaves other callers' searches alone", async () => {
  const older = searchOffThread(db, 'alpha', 10, 'newest', 'w1');
  const other = searchOffThread(db, 'alpha', 10, 'newest', 'w2');
  const newer = searchOffThread(db, 'two', 10, 'newest', 'w1');
  await expect(older).rejects.toThrow('A newer search replaced this one');
  expect(await other).toHaveLength(2);
  expect((await newer).map((h) => h.authorId)).toEqual(['u2']);
});
