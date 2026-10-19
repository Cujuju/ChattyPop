import { afterEach, beforeEach, expect, it } from 'vitest';
import { tempDb } from './helpers';
import { seedArchiveViews } from './archiveViewsFixture';
import { archiveRead } from '../src/core/plugins/pluginDb';
import { closeArchiveReads } from '../src/core/reads/archiveReads';

let db: ReturnType<typeof tempDb>;
let read: ReturnType<typeof archiveRead>;
beforeEach(() => { db = tempDb(); seedArchiveViews(db); read = archiveRead(() => db); });
afterEach(async () => { delete (globalThis as Record<string, unknown>).foldCoreSentinel; await closeArchiveReads(db); });

it('folds visible rows off Core in a read-only worker snapshot', async () => {
  (globalThis as Record<string, unknown>).foldCoreSentinel = true;
  const source = (async (_part: unknown, query: typeof read, _signal: AbortSignal, data: { minimum: number }) => {
    if ((globalThis as Record<string, unknown>).foldCoreSentinel) throw new Error('Fold ran on Core');
    const rows = await query<{ n: number }>('SELECT COUNT(*) AS n FROM archive_messages WHERE ts >= ?', [data.minimum]);
    return [{ twice: rows[0]!.n * 2 }];
  }).toString();
  const [count] = await read<{ n: number }>('SELECT COUNT(*) AS n FROM archive_messages WHERE ts >= ?', [0]);
  expect(await read('SELECT 1', [], { fold: { source, data: { minimum: 0 } }, priority: 'interactive' })).toEqual([{ twice: count!.n * 2 }]);
});

it('rejects writes and honors an already cancelled worker fold', async () => {
  const source = (async (_part: unknown, query: typeof read) => query('DELETE FROM messages RETURNING id')).toString();
  await expect(read('SELECT 1', [], { fold: { source, data: null } })).rejects.toThrow('read-only');
  const controller = new AbortController(); controller.abort(new Error('superseded'));
  await expect(read('SELECT 1', [], { fold: { source, data: null }, signal: controller.signal })).rejects.toThrow('superseded');
  await closeArchiveReads(db);
});
