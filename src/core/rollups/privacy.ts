import type { Db } from '../db';
import { readArchive } from '../reads/archiveReads';
import { MS_PER_S } from '@shared/units';

/** Bound reference-index writes so large catalog updates yield Core between transactions. */
const REFERENCE_APPLY_BATCH_SIZE = 128;

/** Only known channel/server identifiers affect privacy; user mentions and custom emoji remain ordinary aggregate input. */
export const knownReferenceSql = (text: string): string => `EXISTS (
  SELECT 1 FROM channels rk WHERE instr(COALESCE(${text}, ''), rk.id) > 0
  UNION ALL SELECT 1 FROM guilds rg WHERE instr(COALESCE(${text}, ''), rg.id) > 0)`;
export const messageResidualSql = (id: string): string =>
  `${id} IN (SELECT message_id FROM rollup_reference_messages)`;

export function installRollupReferences(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS rollup_reference_messages (message_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS rollup_reference_links (link_id INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS rollup_reference_state (singleton INTEGER PRIMARY KEY, ready INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
    INSERT OR IGNORE INTO rollup_reference_state(singleton, ready) VALUES (1, 0);`);
  for (const [table, target, column, text] of [
    ['messages', 'rollup_reference_messages', 'message_id', 'content'],
    ['links', 'rollup_reference_links', 'link_id', 'url'],
  ]) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${target}_insert AFTER INSERT ON ${table} WHEN ${knownReferenceSql(`new.${text}`)}
      BEGIN INSERT OR IGNORE INTO ${target} VALUES (new.id); END;
      CREATE TRIGGER IF NOT EXISTS ${target}_update AFTER UPDATE OF ${text} ON ${table} WHEN old.${text} IS NOT new.${text}
      BEGIN DELETE FROM ${target} WHERE ${column} = old.id;
        INSERT OR IGNORE INTO ${target} SELECT new.id WHERE ${knownReferenceSql(`new.${text}`)}; END;
      CREATE TRIGGER IF NOT EXISTS ${target}_delete AFTER DELETE ON ${table}
      BEGIN DELETE FROM ${target} WHERE ${column} = old.id; END;`);
  }
  for (const table of ['channels', 'guilds']) for (const operation of ['INSERT', 'DELETE', 'UPDATE OF id']) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS rollup_reference_${table}_${operation.split(' ')[0]!.toLowerCase()} AFTER ${operation} ON ${table}
      BEGIN UPDATE rollup_reference_state SET ready = 0, revision = revision + 1 WHERE singleton = 1; END;`);
  }
}

export const rollupReferencesReady = (db: Db): boolean => Boolean((db.prepare('SELECT ready FROM rollup_reference_state WHERE singleton = 1').get() as { ready: number }).ready);

/** Catalog changes discover reference deltas off-thread; concurrent message writes are rechecked by identifier before classification commits. */
export async function seedRollupReferences(db: Db, signal: AbortSignal): Promise<boolean> {
  const state = db.prepare('SELECT ready, revision FROM rollup_reference_state WHERE singleton = 1').get() as { ready: number; revision: number };
  if (state.ready) return true;
  const rows = await readArchive<{ kind: string; id: string | number; channel_id: string; day: string }>(db,
    `SELECT 'message' AS kind, m.id, m.channel_id, date(m.ts / ${MS_PER_S}, 'unixepoch') AS day FROM messages m
       WHERE ${knownReferenceSql('m.content')} != (m.id IN (SELECT message_id FROM rollup_reference_messages))
     UNION ALL SELECT 'link', l.id, l.first_channel_id, date(l.first_ts / ${MS_PER_S}, 'unixepoch') FROM links l
       WHERE ${knownReferenceSql('l.url')} != (l.id IN (SELECT link_id FROM rollup_reference_links))`, [], signal, 'background');
  signal.throwIfAborted();
  for (let offset = 0; offset < rows.length || offset === 0; offset += REFERENCE_APPLY_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + REFERENCE_APPLY_BATCH_SIZE);
    const applied = db.transaction(() => {
      const current = db.prepare('SELECT ready, revision FROM rollup_reference_state WHERE singleton = 1').get() as typeof state;
      if (current.ready) return true;
      if (current.revision !== state.revision) return false;
      const parts = new Map<string, { channel_id: string; day: string }>();
      for (const row of batch) {
        const message = row.kind === 'message';
        const table = message ? 'messages' : 'links';
        const target = message ? 'rollup_reference_messages' : 'rollup_reference_links';
        const column = message ? 'message_id' : 'link_id';
        const reference = knownReferenceSql(message ? 'content' : 'url');
        db.prepare(`DELETE FROM ${target} WHERE ${column} = ? AND NOT EXISTS (SELECT 1 FROM ${table} WHERE id = ? AND ${reference})`).run(row.id, row.id);
        db.prepare(`INSERT OR IGNORE INTO ${target} SELECT id FROM ${table} WHERE id = ? AND ${reference}`).run(row.id);
        parts.set(`${row.channel_id}/${row.day}`, row);
        const latest = db.prepare(`SELECT ${message ? 'channel_id' : 'first_channel_id'} AS channel_id,
          date(${message ? 'ts' : 'first_ts'} / ${MS_PER_S}, 'unixepoch') AS day FROM ${table} WHERE id = ?`).get(row.id) as { channel_id: string; day: string } | undefined;
        if (latest) parts.set(`${latest.channel_id}/${latest.day}`, latest);
      }
      if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'rollup_meta'").get()) {
        const dirty = db.prepare(`INSERT INTO rollup_dirty(rollup, channel_id, day) SELECT rollup, ?, ? FROM rollup_meta WHERE 1
          ON CONFLICT(rollup, channel_id, day) DO UPDATE SET revision = revision + 1`);
        for (const part of parts.values()) dirty.run(part.channel_id, part.day);
      }
      if (offset + batch.length >= rows.length) db.prepare('UPDATE rollup_reference_state SET ready = 1 WHERE singleton = 1').run();
      return true;
    })();
    if (!applied) return false;
    if (rollupReferencesReady(db)) return true;
    await new Promise<void>((resolve) => setImmediate(resolve));
    signal.throwIfAborted();
  }
  return rollupReferencesReady(db);
}

