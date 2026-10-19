import { describe, expect, it, vi } from 'vitest';
import { pluginDb } from '../src/core/plugins/pluginDb';
import { pluginCalls } from '../src/core/plugins/callContext';
import { decorationReads } from '../src/core/plugins/decorationReads';
import { tempDb } from './helpers';

/** A restored archive window can exceed a single decoration batch, with several notes per message. */
const WINDOW_MESSAGES = 100;
const PARTS_PER_MESSAGE = 4;

describe('live decoration lookup contract', () => {
  it('declares bounded provider reads inside served calls and on host pages; scans remain diagnosed', () => {
    const db = tempDb();
    db.exec('CREATE TABLE decoration_probe (message_id TEXT, part INTEGER, PRIMARY KEY (message_id, part))');
    const ids = Array.from({ length: WINDOW_MESSAGES }, (_, n) => String(n));
    const insert = db.prepare('INSERT INTO decoration_probe VALUES (?, ?)');
    db.transaction(() => { for (const id of ids) for (let part = 0; part < PARTS_PER_MESSAGE; part++) insert.run(id, part); })();
    const storage = pluginDb(() => db, () => true, 'decorator');
    const diag = vi.fn();
    const deps = { diag, strictSyncReads: true };
    const read = (selected: string[]) => new Map(storage.prepare<{ ids: string }, { message_id: string; part: number }>(
      'SELECT message_id, part FROM decoration_probe WHERE message_id IN (SELECT value FROM json_each(@ids))')
      .all({ ids: JSON.stringify(selected) }).map((r) => [`${r.message_id}:${r.part}`, r]));
    const invoke = () => decorationReads('decorator', 'archive.notes', deps, ids, read);
    try {
      expect(invoke().size).toBe(WINDOW_MESSAGES * PARTS_PER_MESSAGE);
      expect(pluginCalls.run({ plugin: 'consumer', member: 'page', reads: true, strict: true,
        signal: new AbortController().signal, priority: 'interactive', diag }, invoke).size).toBe(WINDOW_MESSAGES * PARTS_PER_MESSAGE);
      expect(diag).not.toHaveBeenCalled();
      expect(() => decorationReads('decorator', 'archive.notes', deps, ids, () => {
        storage.prepare('SELECT COUNT(*) FROM decoration_probe').get();
        return new Map();
      })).toThrow('plugin-sync-read: decorator.archive.notes');
      expect(diag).toHaveBeenCalledWith('plugin-sync-read', { plugin: 'decorator', member: 'archive.notes' });
    } finally { db.close(); }
  });
});
