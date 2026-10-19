import { MS_PER_DAY, MS_PER_S } from '@shared/units';
import { pluginTableName } from '@shared/bundledTypes';
import type { Db } from '../db';
import type { RollupPartition, RollupRow, RollupSpec } from './types';
import type { FoldResult } from '../reads/protocol';
import { reconcileDefinition } from './definitions';
import { installSpanTriggers } from './spans';
import { installRollupChanges, pendingChangesSql } from './changes';
import { visibleRollupSql } from './views';
import { liveRollupSql } from './live';
import { installMetadataTriggers } from './metadata';
import { installMaterializedFold, markMaterializedFold } from './materialized';
import { installRollupBuilds } from './build';

export interface Dirty { channel_id: string; day: string; revision: number }
export interface Meta { version: number; zone: string; revision: number; built_through_seq: number; queued_through_seq: number; backfill: number; full_build: number }
const IDENTIFIER = /^[a-z][a-z0-9_]*$/i;

export function installRollupStore(db: Db): void {
  installRollupChanges(db);
  installMetadataTriggers(db);
  db.exec(`CREATE TABLE IF NOT EXISTS rollup_meta (
    rollup TEXT PRIMARY KEY, version INTEGER NOT NULL, zone TEXT NOT NULL,
    built_through_seq INTEGER NOT NULL DEFAULT 0, queued_through_seq INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 0, backfill INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS rollup_dirty (
      rollup TEXT NOT NULL, channel_id TEXT NOT NULL, day TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (rollup, channel_id, day));
    CREATE TABLE IF NOT EXISTS rollup_fold_dirty (rollup TEXT, channel_id TEXT, revision INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(rollup, channel_id));
    CREATE INDEX IF NOT EXISTS rollup_dirty_newest ON rollup_dirty (rollup, day DESC, channel_id);
    CREATE TABLE IF NOT EXISTS rollup_partitions (
      rollup TEXT NOT NULL, channel_id TEXT NOT NULL, day TEXT NOT NULL, watermark INTEGER NOT NULL,
      PRIMARY KEY (rollup, channel_id, day));
    CREATE INDEX IF NOT EXISTS rollup_partitions_channel ON rollup_partitions(channel_id, day);
    CREATE INDEX IF NOT EXISTS rollup_messages_author ON messages(author_id, channel_id, ts);
    CREATE INDEX IF NOT EXISTS rollup_attachments_channel_ts ON attachments(channel_id, ts);
    CREATE INDEX IF NOT EXISTS rollup_links_channel_ts ON links(first_channel_id, first_ts);
    CREATE INDEX IF NOT EXISTS rollup_links_author ON links(first_author_id, first_channel_id, first_ts);
    CREATE TABLE IF NOT EXISTS rollup_visibility_state (singleton INTEGER PRIMARY KEY, revision INTEGER NOT NULL);
    INSERT OR IGNORE INTO rollup_visibility_state VALUES (1, 0);
    CREATE TABLE IF NOT EXISTS rollup_span_generations (
      rollup TEXT NOT NULL, channel_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (rollup, channel_id));
    CREATE TABLE IF NOT EXISTS rollup_span_dirty (
      rollup TEXT NOT NULL, channel_id TEXT NOT NULL, first_day TEXT NOT NULL, last_day TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (rollup, channel_id, first_day, last_day));`);
  for (const table of ['hidden_ids']) for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
    reconcileDefinition(db, `visibility/${table}/${operation}`, `CREATE TRIGGER IF NOT EXISTS rollup_visibility_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table}
      BEGIN UPDATE rollup_visibility_state SET revision = revision + 1 WHERE singleton = 1; END;`);
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('rollup_meta') WHERE name = 'full_build'").get()) {
    db.exec('ALTER TABLE rollup_meta ADD COLUMN full_build INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE rollup_meta SET full_build = backfill');
  }
  installRollupBuilds(db);
}

export function rollupTable<R extends object, D>(db: Db, pluginId: string, name: string, spec: RollupSpec<R, D>): string {
  const columns = Object.entries(spec.columns);
  const keys: readonly string[] = spec.key;
  if (!IDENTIFIER.test(name) || !Number.isSafeInteger(spec.version) || spec.version < 1 || !columns.length || !spec.key.length) throw new Error('Invalid rollup definition');
  for (const [column, type] of columns) {
    if (!IDENTIFIER.test(column) || ['channel_id', 'day'].includes(column) || typeof type !== 'string' || !['TEXT', 'INTEGER', 'REAL'].includes(type)) throw new Error(`Invalid rollup column ${column}`);
  }
  if (new Set(spec.key).size !== spec.key.length || spec.key.some((key) => !Object.hasOwn(spec.columns, key))) throw new Error('Invalid rollup key');
  // Versioned tables preserve old schemas; a version bump never alters a previously created table.
  const table = pluginTableName(pluginId, `rollup_${name}_v${spec.version}`);
  const id = `${pluginId}.${name}`;
  db.exec(`CREATE TABLE IF NOT EXISTS "${table}" (channel_id TEXT NOT NULL, day TEXT NOT NULL,
    ${columns.map(([column, type]) => `"${column}" ${type}${keys.includes(column) ? ' NOT NULL' : ''}`).join(', ')},
    PRIMARY KEY (channel_id, day, ${spec.key.map((key) => `"${key}"`).join(', ')}))`);
  db.exec(`CREATE INDEX IF NOT EXISTS "${table}_day" ON "${table}" (day, channel_id)`);
  for (const [index, keys] of (spec.indexes ?? []).entries()) {
    if (!keys.length || keys.some((key) => !Object.hasOwn(spec.columns, key))) throw new Error('Invalid rollup index');
    db.exec(`CREATE INDEX IF NOT EXISTS "${table}_read_${index}" ON "${table}" (${keys.map((key) => `"${key}"`).join(', ')})`);
  }
  if (spec.span) installSpanTriggers(db, id, table, spec.columns, spec.span);
  reconcileDefinition(db, `${table}/live`, `CREATE VIEW "${table}_live_visible" AS ${liveRollupSql(id, table, spec.span)}`);
  reconcileDefinition(db, `${table}/visible`, `CREATE VIEW IF NOT EXISTS "${table}_visible" AS ${visibleRollupSql(id, table, Boolean(spec.span))}`);
  if (spec.fold) installMaterializedFold(db, id, table, spec.fold);
  if (spec.allTime) {
    if (Object.keys(spec.allTime.values).length !== columns.length - spec.key.length || columns.some(([column]) => !keys.includes(column) && !['sum', 'min', 'max', 'latest', 'earliest'].includes(spec.allTime!.values[column] ?? ''))) throw new Error('Invalid all-time fold columns');
    if (Object.values(spec.allTime.values).some((value) => value === 'latest' || value === 'earliest') && (!spec.allTime.orderBy || !Object.hasOwn(spec.columns, spec.allTime.orderBy))) throw new Error('Ordered fold needs its ordering column');
    db.exec(`CREATE INDEX IF NOT EXISTS "${table}_fold" ON "${table}" (channel_id, ${spec.key.map((key) => `"${key}"`).join(', ')}, day);
      CREATE TABLE IF NOT EXISTS "${table}_all_time" (channel_id TEXT NOT NULL,
        ${columns.map(([column, type]) => `"${column}" ${type}${keys.includes(column) ? ' NOT NULL' : ''}`).join(', ')},
        PRIMARY KEY(channel_id, ${spec.key.map((key) => `"${key}"`).join(', ')}));
`);
    reconcileDefinition(db, `${table}/all-time-visible`, `CREATE VIEW IF NOT EXISTS "${table}_all_time_visible" AS ${visibleRollupSql(id, table, Boolean(spec.span), true)}`);
  }
  return table;
}

export function markPartitions(db: Db, id: string, parts: readonly { channel_id: string; day: string }[]): void {
  const mark = db.prepare(`INSERT INTO rollup_dirty(rollup, channel_id, day) VALUES (?, ?, ?)
    ON CONFLICT(rollup, channel_id, day) DO UPDATE SET revision = revision + 1`);
  db.transaction(() => { for (const part of parts) mark.run(id, part.channel_id, part.day); })();
}

export function partition(channelId: string, day: string, timeZone: string): RollupPartition {
  const startTs = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(startTs)) throw new Error('Invalid UTC rollup day');
  return { channelId, day, startTs, endTs: startTs + MS_PER_DAY, timeZone };
}

/** Includes orphan files/links and previously built empty partitions, so deletion and scope rebuilds clear old rows. */
export const PARTITIONS_SQL = `SELECT channel_id, date(ts / ${MS_PER_S}, 'unixepoch') AS day, seq FROM messages
  UNION ALL SELECT channel_id, date(ts / ${MS_PER_S}, 'unixepoch'), 0 FROM attachments
  UNION ALL SELECT first_channel_id, date(first_ts / ${MS_PER_S}, 'unixepoch'), 0 FROM links
  UNION ALL SELECT channel_id, day, 0 FROM rollup_partitions WHERE rollup = @rollup`;

export function replacePartition(db: Db, id: string, table: string, dirty: Dirty, columns: readonly string[], rows: RollupRow[], watermark: number, fold?: FoldResult, materialized = false): void {
  db.transaction(() => {
    if (db.prepare(`SELECT ${pendingChangesSql('?', '?', '?')}`).pluck().get(id, dirty.channel_id, dirty.day)) return;
    const current = db.prepare('SELECT revision FROM rollup_dirty WHERE rollup = ? AND channel_id = ? AND day = ?').get(id, dirty.channel_id, dirty.day) as { revision: number } | undefined;
    if (current?.revision !== dirty.revision) return;
    if (materialized) markMaterializedFold(db, id, dirty.channel_id);
    db.prepare(`DELETE FROM "${table}" WHERE channel_id = ? AND day = ?`).run(dirty.channel_id, dirty.day);
    const insert = db.prepare(`INSERT INTO "${table}" (channel_id, day, ${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${Array(columns.length + 2).fill('?').join(', ')})`);
    for (const row of rows) {
      if (Object.keys(row).length !== columns.length || columns.some((c) => !Object.hasOwn(row, c))) throw new Error('Rollup returned unexpected columns');
      insert.run(dirty.channel_id, dirty.day, ...columns.map((c) => row[c]));
    }
    if (fold?.keys.length) {
      const keys = Object.keys(fold.keys[0] ?? {});
      const remove = db.prepare(`DELETE FROM "${table}_all_time" WHERE channel_id = ? AND ${keys.map((key) => `"${key}" = ?`).join(' AND ') || '0'}`);
      const retained = new Set(fold.rows.map((row) => JSON.stringify(keys.map((column) => row[column]))));
      for (const key of fold.keys) if (!retained.has(JSON.stringify(keys.map((column) => key[column])))) remove.run(dirty.channel_id, ...keys.map((column) => key[column]));
      const values = columns.filter((column) => !keys.includes(column));
      const folded = db.prepare(`INSERT INTO "${table}_all_time" (channel_id, ${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${Array(columns.length + 1).fill('?').join(', ')})
        ON CONFLICT(channel_id, ${keys.map((c) => `"${c}"`).join(', ')}) DO ${values.length ? `UPDATE SET ${values.map((c) => `"${c}" = excluded."${c}"`).join(', ')}
          WHERE ${values.map((c) => `"${table}_all_time"."${c}" IS NOT excluded."${c}"`).join(' OR ')}` : 'NOTHING'}`);
      for (const row of fold.rows) folded.run(dirty.channel_id, ...columns.map((column) => row[column]));
    }
    db.prepare(`INSERT INTO rollup_partitions VALUES (?, ?, ?, ?)
      ON CONFLICT(rollup, channel_id, day) DO UPDATE SET watermark = excluded.watermark`).run(id, dirty.channel_id, dirty.day, watermark);
    db.prepare('DELETE FROM rollup_dirty WHERE rollup = ? AND channel_id = ? AND day = ? AND revision = ?').run(id, dirty.channel_id, dirty.day, dirty.revision);
    // A partition's watermark is not global coverage while older dirty partitions remain.
    db.prepare(`UPDATE rollup_meta SET revision = revision + 1, built_through_seq = CASE
      WHEN backfill = 0 AND NOT EXISTS (SELECT 1 FROM rollup_dirty WHERE rollup = ?) THEN MAX(built_through_seq, ?)
      ELSE built_through_seq END WHERE rollup = ?`).run(id, watermark, id);
  })();
}
