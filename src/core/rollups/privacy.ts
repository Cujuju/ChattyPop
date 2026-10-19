import type { Db } from '../db';
import { readArchive } from '../reads/archiveReads';
import { MS_PER_S } from '@shared/units';
import { reconcileDefinition } from './definitions';
import { referencePartitionSql, installReferenceChanges, acknowledgeReferenceChanges } from './referenceChanges';

const REFERENCE_APPLY_BATCH_SIZE = 128; // Bounded transactions yield Core during large reference-index updates.
const draining = new WeakMap<Db, Promise<boolean>>();

/** Evaluated only by background readers, never by ingest triggers or Core reference-index writes. */
export const knownReferenceSql = (text: string): string => `EXISTS (
  SELECT 1 FROM channels rk WHERE instr(COALESCE(${text}, ''), rk.id) > 0
  UNION ALL SELECT 1 FROM guilds rg WHERE instr(COALESCE(${text}, ''), rg.id) > 0)`;
export const messageResidualSql = (id: string): string => `${id} IN (SELECT message_id FROM rollup_reference_messages)`;

export function installRollupReferences(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS rollup_reference_messages (message_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS rollup_reference_links (link_id INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS rollup_reference_state (singleton INTEGER PRIMARY KEY, ready INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
    INSERT OR IGNORE INTO rollup_reference_state(singleton, ready) VALUES (1, 0);
    CREATE TABLE IF NOT EXISTS rollup_reference_pending (kind TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(kind, id));
    CREATE TABLE IF NOT EXISTS rollup_reference_catalog (id TEXT PRIMARY KEY);`);
  if (!db.prepare("SELECT 1 FROM pragma_table_info('rollup_reference_state') WHERE name = 'mutation'").get()) db.exec('ALTER TABLE rollup_reference_state ADD COLUMN mutation INTEGER NOT NULL DEFAULT 0');
  if (!db.prepare("SELECT 1 FROM pragma_table_info('rollup_reference_pending') WHERE name = 'revision'").get()) db.exec('ALTER TABLE rollup_reference_pending ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE INDEX IF NOT EXISTS rollup_reference_pending_revision ON rollup_reference_pending(revision)');
  installReferenceChanges(db);
  for (const [table, kind, target, column, text] of [
    ['messages', 'message', 'rollup_reference_messages', 'message_id', 'content'],
    ['links', 'link', 'rollup_reference_links', 'link_id', 'url'],
  ]) {
    const channel = kind === 'message' ? 'channel_id' : 'first_channel_id';
    const ts = kind === 'message' ? 'ts' : 'first_ts';
    const queued = `SELECT 1 FROM rollup_reference_changes WHERE kind = '${kind}' AND channel_id = new.${channel}
      AND day = date(new.${ts} / ${MS_PER_S}, 'unixepoch') AND revision = (SELECT mutation FROM rollup_reference_state WHERE singleton = 1)
      UNION ALL SELECT 1 FROM rollup_reference_pending WHERE new.${ts} IS NULL AND kind = '${kind}' AND id = new.id
        AND revision = (SELECT mutation FROM rollup_reference_state WHERE singleton = 1)`;
    const enqueue = `INSERT INTO rollup_reference_changes(kind, channel_id, day, revision)
      SELECT '${kind}', new.${channel}, date(new.${ts} / ${MS_PER_S}, 'unixepoch'), mutation FROM rollup_reference_state WHERE singleton = 1 AND new.${ts} IS NOT NULL
      ON CONFLICT(kind, channel_id, day) DO UPDATE SET revision = excluded.revision;
      INSERT INTO rollup_reference_pending(kind, id, revision)
      SELECT '${kind}', new.id, mutation FROM rollup_reference_state WHERE singleton = 1 AND new.${ts} IS NULL
      ON CONFLICT(kind, id) DO UPDATE SET revision = excluded.revision;`;
    reconcileDefinition(db, `${target}/triggers`, `CREATE TRIGGER IF NOT EXISTS ${target}_insert AFTER INSERT ON ${table}
      WHEN NOT EXISTS (${queued}) BEGIN ${enqueue} END;
      CREATE TRIGGER IF NOT EXISTS ${target}_update AFTER UPDATE OF ${text} ON ${table} WHEN old.${text} IS NOT new.${text}
      AND NOT EXISTS (${queued}) BEGIN ${enqueue} END;
      CREATE TRIGGER IF NOT EXISTS ${target}_delete AFTER DELETE ON ${table}
      BEGIN DELETE FROM ${target} WHERE ${column} = old.id;
        DELETE FROM rollup_reference_pending WHERE kind = '${kind}' AND id = old.id; END;`);
  }
  for (const table of ['channels', 'guilds']) for (const operation of ['INSERT', 'DELETE', 'UPDATE OF id']) {
    const name = `rollup_reference_${table}_${operation.split(' ')[0]!.toLowerCase()}`;
    const aliases = operation === 'INSERT' ? ['new'] : operation === 'DELETE' ? ['old'] : ['old', 'new'];
    reconcileDefinition(db, name, `CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${operation} ON ${table}
      BEGIN ${aliases.map((alias) => `INSERT OR IGNORE INTO rollup_reference_catalog VALUES (${alias}.id);`).join(' ')}
        UPDATE rollup_reference_state SET revision = revision + 1 WHERE singleton = 1; END;`);
  }
}

export const rollupReferencesReady = (db: Db): boolean => Boolean(db.prepare('SELECT ready FROM rollup_reference_state WHERE singleton = 1').pluck().get());
export const referenceWorkPending = (db: Db): boolean => !rollupReferencesReady(db) || Boolean(db.prepare(`SELECT 1 FROM rollup_reference_pending
  UNION ALL SELECT 1 FROM rollup_reference_changes
  UNION ALL SELECT 1 FROM rollup_reference_catalog LIMIT 1`).get());

/** Pending catalog ids suppress only matching partitions until background classification completes, including privacy changes during discovery. */
export function pendingReferenceSql(channel: string, day?: string): string {
  const time = (ts: string) => day ? ` AND ${ts} >= unixepoch(${day}) * ${MS_PER_S} AND ${ts} < unixepoch(${day}, '+1 day') * ${MS_PER_S}` : '';
  return `NOT EXISTS (SELECT 1 FROM rollup_reference_catalog rc WHERE
    EXISTS (SELECT 1 FROM messages pm WHERE pm.channel_id = ${channel}${time('pm.ts')} AND instr(pm.content, rc.id) > 0)
    OR EXISTS (SELECT 1 FROM links pl WHERE pl.first_channel_id = ${channel}${time('pl.first_ts')} AND instr(pl.url, rc.id) > 0))`;
}

interface ReferenceRow { kind: string; id: string | number; channel_id: string; day: string; text: string; referenced: number }

/** Catalog enumeration scans only changed ids; ordinary drains join queued row ids through primary keys. */
async function drainReferences(db: Db, signal: AbortSignal): Promise<boolean> {
  if (!referenceWorkPending(db)) return true;
  const state = db.prepare('SELECT ready, revision, mutation FROM rollup_reference_state WHERE singleton = 1').get() as { ready: number; revision: number; mutation: number };
  // Writers arriving after this snapshot retain the next epoch, even for an already queued day.
  db.prepare('UPDATE rollup_reference_state SET mutation = mutation + 1 WHERE singleton = 1').run();
  let rows: ReferenceRow[] = [];
  for (const [table, kind, text, channel, ts, target, column] of [
    ['messages', 'message', 'content', 'channel_id', 'ts', 'rollup_reference_messages', 'message_id'],
    ['links', 'link', 'url', 'first_channel_id', 'first_ts', 'rollup_reference_links', 'link_id'],
  ]) {
    rows = rows.concat(await readArchive<ReferenceRow>(db, `WITH candidates AS (
      SELECT id FROM ${table} WHERE @bootstrap
      UNION SELECT t.id FROM rollup_reference_pending p CROSS JOIN ${table} t ON t.id = p.id WHERE p.kind = '${kind}'
      UNION ${referencePartitionSql(table!, kind!, channel!, ts!)}
      UNION SELECT t.id FROM rollup_reference_catalog c CROSS JOIN ${table} t WHERE instr(t.${text}, c.id) > 0)
      SELECT '${kind}' AS kind, t.id, t.${channel} AS channel_id, date(t.${ts} / ${MS_PER_S}, 'unixepoch') AS day,
        t.${text} AS text, ${knownReferenceSql(`t.${text}`)} AS referenced FROM candidates c JOIN ${table} t ON t.id = c.id
      WHERE ${knownReferenceSql(`t.${text}`)} != EXISTS (SELECT 1 FROM ${target} indexed_row WHERE indexed_row.${column} = t.id)`,
    { bootstrap: Number(!state.ready) }, signal, 'background'));
  }
  signal.throwIfAborted();
  if (db.prepare('SELECT revision FROM rollup_reference_state WHERE singleton = 1').pluck().get() !== state.revision) return false;
  const statements = new Map(['message', 'link'].map((kind) => {
    const message = kind === 'message', table = message ? 'messages' : 'links', text = message ? 'content' : 'url';
    const target = message ? 'rollup_reference_messages' : 'rollup_reference_links', column = message ? 'message_id' : 'link_id';
    return [kind, { current: db.prepare(`SELECT ${text} FROM ${table} WHERE id = ?`),
      insert: db.prepare(`INSERT OR IGNORE INTO ${target} VALUES (?)`), remove: db.prepare(`DELETE FROM ${target} WHERE ${column} = ?`) }];
  }));
  const dirty = db.prepare(`INSERT INTO rollup_dirty(rollup, channel_id, day) SELECT rollup, ?, ? FROM rollup_meta WHERE 1
    ON CONFLICT(rollup, channel_id, day) DO UPDATE SET revision = revision + 1`);
  for (let offset = 0; offset < rows.length; offset += REFERENCE_APPLY_BATCH_SIZE) {
    db.transaction(() => {
      for (const row of rows.slice(offset, offset + REFERENCE_APPLY_BATCH_SIZE)) {
        const batch = statements.get(row.kind)!;
        const current = batch.current.pluck().get(row.id);
        if (current !== row.text) continue;
        if (row.referenced) batch.insert.run(row.id); else batch.remove.run(row.id);
        dirty.run(row.channel_id, row.day);
      }
    })();
    await new Promise<void>((resolve) => setImmediate(resolve));
    signal.throwIfAborted();
    if (db.prepare('SELECT revision FROM rollup_reference_state WHERE singleton = 1').pluck().get() !== state.revision) return false;
  }
  const acknowledge = db.prepare(`DELETE FROM rollup_reference_pending WHERE rowid IN (
    SELECT rowid FROM rollup_reference_pending WHERE revision <= ? LIMIT ?)`);
  while (acknowledge.run(state.mutation, REFERENCE_APPLY_BATCH_SIZE).changes) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    signal.throwIfAborted();
    if (db.prepare('SELECT revision FROM rollup_reference_state WHERE singleton = 1').pluck().get() !== state.revision) return false;
  }
  await acknowledgeReferenceChanges(db, state.mutation, signal);
  if (db.prepare('SELECT revision FROM rollup_reference_state WHERE singleton = 1').pluck().get() !== state.revision) return false;
  db.transaction(() => {
    db.exec('DELETE FROM rollup_reference_catalog');
    db.prepare('UPDATE rollup_reference_state SET ready = 1 WHERE singleton = 1').run();
  })();
  return !referenceWorkPending(db);
}

/** A database has one reference-index writer even when several rollups drain concurrently. */
export function seedRollupReferences(db: Db, signal: AbortSignal): Promise<boolean> {
  const pending = draining.get(db);
  if (pending) return pending;
  const work = drainReferences(db, signal).finally(() => draining.delete(db));
  draining.set(db, work);
  return work;
}
