import type { Db } from '../db';
import type { RollupFold, RollupRow } from './types';
import { reconcileDefinition } from './definitions';
import { visibleRollupSql } from './views';

const IDENTIFIER = /^[a-z][a-z0-9_]*$/i;

export function installMaterializedFold(db: Db, id: string, table: string, spec: RollupFold): void {
  const columns = Object.entries(spec.columns);
  if (!columns.length || !spec.key.length || columns.some(([c, t]) => !IDENTIFIER.test(c) || c === 'channel_id' || !['TEXT', 'INTEGER', 'REAL'].includes(t))
    || new Set(spec.key).size !== spec.key.length || spec.key.some((k) => !Object.hasOwn(spec.columns, k))) throw new Error('Invalid materialized fold');
  db.exec(`CREATE TABLE IF NOT EXISTS rollup_fold_dirty (rollup TEXT, channel_id TEXT, revision INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(rollup, channel_id));
    CREATE TABLE IF NOT EXISTS "${table}_folded" (channel_id TEXT NOT NULL,
      ${columns.map(([c, t]) => `"${c}" ${t}${spec.key.includes(c) ? ' NOT NULL' : ''}`).join(', ')},
      PRIMARY KEY(channel_id, ${spec.key.map((c) => `"${c}"`).join(', ')}));`);
  for (const [i, keys] of (spec.indexes ?? []).entries()) {
    if (!keys.length || keys.some((k) => !Object.hasOwn(spec.columns, k))) throw new Error('Invalid materialized fold index');
    db.exec(`CREATE INDEX IF NOT EXISTS "${table}_folded_read_${i}" ON "${table}_folded" (channel_id, ${keys.map((c) => `"${c}"`).join(', ')})`);
  }
  reconcileDefinition(db, `${table}/folded-visible`, `CREATE VIEW "${table}_folded_visible" AS
    ${visibleRollupSql(id, table, false, true).replaceAll(`${table}_all_time`, `${table}_folded`)}
    AND NOT EXISTS (SELECT 1 FROM rollup_fold_dirty f WHERE f.rollup = '${id}' AND f.channel_id = r.channel_id)`);
}

/** The daily publication and its durable fold request share a transaction. */
export function markMaterializedFold(db: Db, id: string, channel: string): void {
  db.prepare(`INSERT INTO rollup_fold_dirty(rollup, channel_id) VALUES (?, ?)
    ON CONFLICT(rollup, channel_id) DO UPDATE SET revision = revision + 1`).run(id, channel);
}

const PUBLISH_BATCH_ROWS = 256; // Bound writer turns while the dirty gate hides incomplete indexes.

export async function publishMaterializedFold(db: Db, id: string, table: string, spec: RollupFold,
  channel: string, revision: number, rows: RollupRow[], current: () => boolean): Promise<boolean> {
  const valid = () => current() && db.prepare('SELECT revision FROM rollup_fold_dirty WHERE rollup = ? AND channel_id = ?').pluck().get(id, channel) === revision;
  const remove = db.prepare(`DELETE FROM "${table}_folded" WHERE rowid IN (
    SELECT rowid FROM "${table}_folded" WHERE channel_id = ? LIMIT ?)`);
  while (valid() && remove.run(channel, PUBLISH_BATCH_ROWS).changes) await new Promise<void>((resolve) => setImmediate(resolve));
  if (!valid()) return false;
  const columns = Object.keys(spec.columns);
  const insert = db.prepare(`INSERT INTO "${table}_folded" (channel_id, ${columns.map((c) => `"${c}"`).join(', ')})
    VALUES (${Array(columns.length + 1).fill('?').join(', ')})`);
  const batch = db.transaction((start: number) => {
    for (const row of rows.slice(start, start + PUBLISH_BATCH_ROWS)) {
      if (Object.keys(row).length !== columns.length || columns.some((c) => !Object.hasOwn(row, c))) throw new Error('Fold returned unexpected columns');
      insert.run(channel, ...columns.map((c) => row[c]));
    }
  });
  for (let start = 0; start < rows.length; start += PUBLISH_BATCH_ROWS) {
    if (!valid()) return false;
    batch(start);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (!valid()) return false;
  db.transaction(() => {
    db.prepare('DELETE FROM rollup_fold_dirty WHERE rollup = ? AND channel_id = ? AND revision = ?').run(id, channel, revision);
    db.prepare('UPDATE rollup_meta SET revision = revision + 1 WHERE rollup = ?').run(id);
  })();
  return true;
}
