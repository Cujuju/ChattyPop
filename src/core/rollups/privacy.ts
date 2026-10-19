import type { Db } from '../db';
import { readArchive } from '../reads/archiveReads';
import { MS_PER_S } from '@shared/units';
import { reconcileDefinition } from './definitions';

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
  for (const [table, kind, target, column, text] of [
    ['messages', 'message', 'rollup_reference_messages', 'message_id', 'content'],
    ['links', 'link', 'rollup_reference_links', 'link_id', 'url'],
  ]) {
    reconcileDefinition(db, `${target}/triggers`, `CREATE TRIGGER IF NOT EXISTS ${target}_insert AFTER INSERT ON ${table}
      BEGIN INSERT OR IGNORE INTO rollup_reference_pending VALUES ('${kind}', new.id); END;
      CREATE TRIGGER IF NOT EXISTS ${target}_update AFTER UPDATE OF ${text} ON ${table} WHEN old.${text} IS NOT new.${text}
      BEGIN INSERT OR IGNORE INTO rollup_reference_pending VALUES ('${kind}', new.id); END;
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
  const state = db.prepare('SELECT ready, revision FROM rollup_reference_state WHERE singleton = 1').get() as { ready: number; revision: number };
  const rows: ReferenceRow[] = [];
  for (const [table, kind, text, channel, ts] of [
    ['messages', 'message', 'content', 'channel_id', 'ts'], ['links', 'link', 'url', 'first_channel_id', 'first_ts'],
  ]) {
    rows.push(...await readArchive<ReferenceRow>(db, `WITH candidates AS (
      SELECT id FROM ${table} WHERE @bootstrap
      UNION SELECT t.id FROM rollup_reference_pending p CROSS JOIN ${table} t ON t.id = p.id WHERE p.kind = '${kind}'
      UNION SELECT t.id FROM rollup_reference_catalog c CROSS JOIN ${table} t WHERE instr(t.${text}, c.id) > 0)
      SELECT '${kind}' AS kind, t.id, t.${channel} AS channel_id, date(t.${ts} / ${MS_PER_S}, 'unixepoch') AS day,
        t.${text} AS text, ${knownReferenceSql(`t.${text}`)} AS referenced FROM candidates c JOIN ${table} t ON t.id = c.id`,
    { bootstrap: Number(!state.ready) }, signal, 'background'));
  }
  signal.throwIfAborted();
  if (db.prepare('SELECT revision FROM rollup_reference_state WHERE singleton = 1').pluck().get() !== state.revision) return false;
  for (let offset = 0; offset < rows.length; offset += REFERENCE_APPLY_BATCH_SIZE) {
    db.transaction(() => {
      for (const row of rows.slice(offset, offset + REFERENCE_APPLY_BATCH_SIZE)) {
        const message = row.kind === 'message';
        const table = message ? 'messages' : 'links', text = message ? 'content' : 'url';
        const current = db.prepare(`SELECT ${text} FROM ${table} WHERE id = ?`).pluck().get(row.id);
        if (current !== row.text) continue;
        const target = message ? 'rollup_reference_messages' : 'rollup_reference_links';
        const column = message ? 'message_id' : 'link_id';
        const previous = Boolean(db.prepare(`SELECT 1 FROM ${target} WHERE ${column} = ?`).get(row.id));
        if (row.referenced) db.prepare(`INSERT OR IGNORE INTO ${target} VALUES (?)`).run(row.id);
        else db.prepare(`DELETE FROM ${target} WHERE ${column} = ?`).run(row.id);
        db.prepare('DELETE FROM rollup_reference_pending WHERE kind = ? AND id = ?').run(row.kind, String(row.id));
        if (previous !== Boolean(row.referenced) && db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'rollup_meta'").get()) {
          db.prepare(`INSERT INTO rollup_dirty(rollup, channel_id, day) SELECT rollup, ?, ? FROM rollup_meta WHERE 1
            ON CONFLICT(rollup, channel_id, day) DO UPDATE SET revision = revision + 1`).run(row.channel_id, row.day);
        }
      }
    })();
    await new Promise<void>((resolve) => setImmediate(resolve));
    signal.throwIfAborted();
    if (db.prepare('SELECT revision FROM rollup_reference_state WHERE singleton = 1').pluck().get() !== state.revision) return false;
  }
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
