import { expect, it, vi } from 'vitest';
import { foldRollup } from '../src/core/reads/rollupFold';
import { tempDb } from './helpers';

it('replaces affected hash maxima and drives indexed lookups from the changed keys', () => {
  const db = tempDb();
  db.exec(`CREATE TABLE p_probe_files(channel_id TEXT, day TEXT, hash TEXT, bytes INTEGER);
    CREATE INDEX p_probe_files_fold ON p_probe_files(channel_id, hash, day);
    INSERT INTO p_probe_files VALUES ('channel', '2026-01-01', 'shared', 200),
      ('channel', '2026-01-02', 'shared', 100), ('channel', '2026-01-01', 'removed', 50);`);
  const prepare = db.prepare.bind(db);
  let source = '';
  const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
    if (sql.startsWith('WITH keys')) source = sql;
    return prepare(sql);
  }) as typeof db.prepare);
  try {
    const result = foldRollup(db, { table: 'p_probe_files', keys: ['hash'], values: { bytes: 'max' } },
      { channelId: 'channel', day: '2026-01-01' }, [{ hash: 'shared', bytes: 80 }]);
    expect(result.rows).toEqual([{ hash: 'shared', bytes: 100 }]);
    expect(result.keys.map((key) => key.hash).sort()).toEqual(['removed', 'shared']);
    const plan = prepare(`EXPLAIN QUERY PLAN ${source}`).all({ keys: '[]', rows: '[]', channel: 'channel', day: '2026-01-01' }) as { detail: string }[];
    expect(plan.some((row) => row.detail.includes('(channel_id=? AND hash=?)'))).toBe(true);
  } finally { spy.mockRestore(); db.close(); }
});

it('preserves the position belonging to the lowest ingested sequence across partitions', () => {
  const db = tempDb();
  db.exec(`CREATE TABLE p_probe_words(channel_id TEXT, day TEXT, word TEXT, n INTEGER, first_seq INTEGER, first_position INTEGER);
    CREATE INDEX p_probe_words_fold ON p_probe_words(channel_id, word, day);
    INSERT INTO p_probe_words VALUES ('channel', '2026-01-01', 'word', 1, 3, 7);`);
  try {
    const result = foldRollup(db, { table: 'p_probe_words', keys: ['word'],
      values: { n: 'sum', first_seq: 'min', first_position: 'earliest' }, orderBy: 'first_seq' },
      { channelId: 'channel', day: '2026-01-02' }, [{ word: 'word', n: 1, first_seq: 5, first_position: 1 }]);
    expect(result.rows).toEqual([{ word: 'word', n: 2, first_seq: 3, first_position: 7 }]);
  } finally { db.close(); }
});
