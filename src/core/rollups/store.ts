import { MS_PER_DAY, MS_PER_S } from '@shared/units';
import { pluginTableName } from '@shared/bundledTypes';
import type { Db } from '../db';
import { visibleChannelSql } from '../queries/privacy';
import type { RollupPartition, RollupRow, RollupSpec } from './types';
import type { FoldResult } from '../reads/protocol';

export interface Dirty { channel_id: string; day: string; revision: number }
export interface Meta { version: number; zone: string; revision: number; built_through_seq: number; queued_through_seq: number; backfill: number }
const IDENTIFIER = /^[a-z][a-z0-9_]*$/i;

export function installRollupStore(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS rollup_meta (
    rollup TEXT PRIMARY KEY, version INTEGER NOT NULL, zone TEXT NOT NULL,
    built_through_seq INTEGER NOT NULL DEFAULT 0, queued_through_seq INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 0, backfill INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS rollup_dirty (
      rollup TEXT NOT NULL, channel_id TEXT NOT NULL, day TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (rollup, channel_id, day));
    CREATE INDEX IF NOT EXISTS rollup_dirty_newest ON rollup_dirty (rollup, day DESC, channel_id);
    CREATE TABLE IF NOT EXISTS rollup_partitions (
      rollup TEXT NOT NULL, channel_id TEXT NOT NULL, day TEXT NOT NULL, watermark INTEGER NOT NULL,
      PRIMARY KEY (rollup, channel_id, day));`);
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
  const ready = `(SELECT ready FROM rollup_reference_state WHERE singleton = 1) = 1
    AND (SELECT backfill FROM rollup_meta WHERE rollup = '${id}') = 0`;
  const clean = `NOT EXISTS (SELECT 1 FROM rollup_dirty WHERE rollup = '${id}')`;
  db.exec(`CREATE TABLE IF NOT EXISTS "${table}" (channel_id TEXT NOT NULL, day TEXT NOT NULL,
    ${columns.map(([column, type]) => `"${column}" ${type}${keys.includes(column) ? ' NOT NULL' : ''}`).join(', ')},
    PRIMARY KEY (channel_id, day, ${spec.key.map((key) => `"${key}"`).join(', ')}))`);
  db.exec(`CREATE VIEW IF NOT EXISTS "${table}_visible" AS SELECT * FROM "${table}" r WHERE ${visibleChannelSql('r.channel_id')} AND ${ready}
    AND (${clean} OR NOT EXISTS (SELECT 1 FROM rollup_dirty d WHERE d.rollup = '${id}' AND d.channel_id = r.channel_id AND (d.day = r.day OR d.day = '')))`);
  for (const [index, keys] of (spec.indexes ?? []).entries()) {
    if (!keys.length || keys.some((key) => !Object.hasOwn(spec.columns, key))) throw new Error('Invalid rollup index');
    db.exec(`CREATE INDEX IF NOT EXISTS "${table}_read_${index}" ON "${table}" (${keys.map((key) => `"${key}"`).join(', ')})`);
  }
  if (spec.allTime) {
    if (Object.keys(spec.allTime.values).length !== columns.length - spec.key.length || columns.some(([column]) => !keys.includes(column) && !['sum', 'min', 'max', 'latest', 'earliest'].includes(spec.allTime!.values[column] ?? ''))) throw new Error('Invalid all-time fold columns');
    if (Object.values(spec.allTime.values).some((value) => value === 'latest' || value === 'earliest') && (!spec.allTime.orderBy || !Object.hasOwn(spec.columns, spec.allTime.orderBy))) throw new Error('Ordered fold needs its ordering column');
    db.exec(`CREATE INDEX IF NOT EXISTS "${table}_fold" ON "${table}" (channel_id, ${spec.key.map((key) => `"${key}"`).join(', ')}, day);
      CREATE TABLE IF NOT EXISTS "${table}_all_time" (channel_id TEXT NOT NULL,
        ${columns.map(([column, type]) => `"${column}" ${type}${keys.includes(column) ? ' NOT NULL' : ''}`).join(', ')},
        PRIMARY KEY(channel_id, ${spec.key.map((key) => `"${key}"`).join(', ')}));
      CREATE VIEW IF NOT EXISTS "${table}_all_time_visible" AS SELECT * FROM "${table}_all_time" r WHERE ${visibleChannelSql('r.channel_id')} AND ${ready}
        AND (${clean} OR NOT EXISTS (SELECT 1 FROM rollup_dirty d WHERE d.rollup = '${id}' AND d.channel_id = r.channel_id))`);
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

export function replacePartition(db: Db, id: string, table: string, dirty: Dirty, columns: readonly string[], rows: RollupRow[], watermark: number, fold?: FoldResult): void {
  db.transaction(() => {
    const current = db.prepare('SELECT revision FROM rollup_dirty WHERE rollup = ? AND channel_id = ? AND day = ?').get(id, dirty.channel_id, dirty.day) as { revision: number } | undefined;
    if (current?.revision !== dirty.revision) return;
    db.prepare(`DELETE FROM "${table}" WHERE channel_id = ? AND day = ?`).run(dirty.channel_id, dirty.day);
    const insert = db.prepare(`INSERT INTO "${table}" (channel_id, day, ${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${Array(columns.length + 2).fill('?').join(', ')})`);
    for (const row of rows) {
      if (Object.keys(row).length !== columns.length || columns.some((c) => !Object.hasOwn(row, c))) throw new Error('Rollup returned unexpected columns');
      insert.run(dirty.channel_id, dirty.day, ...columns.map((c) => row[c]));
    }
    if (fold) {
      const keys = Object.keys(fold.keys[0] ?? {});
      const remove = db.prepare(`DELETE FROM "${table}_all_time" WHERE channel_id = ? AND ${keys.map((key) => `"${key}" = ?`).join(' AND ') || '0'}`);
      for (const key of fold.keys) remove.run(dirty.channel_id, ...keys.map((column) => key[column]));
      const folded = db.prepare(`INSERT INTO "${table}_all_time" (channel_id, ${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${Array(columns.length + 1).fill('?').join(', ')})`);
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
