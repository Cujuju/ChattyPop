// Which plugin owns each plugin table, and which plugins have run. A name doesn't say where the id ends (p_foo_bar_items
// is foo's bar_items or foo-bar's items), and a removed plugin's tables stay, so a plugin runs only while every table in
// its namespace is its own.
import { pluginTablePrefix } from '@shared/bundledTypes';
import { tableIds } from '@shared/pluginRestore';
import type { Db } from '../db';

/** A plugin preference's stored key, which names its id: plugin.<id>.<name> (pluginSettingKey); its schema version is one. */
export const PREFERENCE_KEY = /^plugin\.([^.]+)\./;
/** Every plugin table's name starts so (pluginTablePrefix). */
const PLUGIN_TABLE_PREFIX = 'p_';

/** The archive's tables whose names start with `prefix`. */
const tablesStarting = (db: Db, prefix: string): string[] =>
  db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, length(@prefix)) = @prefix ORDER BY name`).pluck().all({ prefix }) as string[];

/** Ids whose data the archive shows: a recorded table's owner, or a stored preference's (its schema version included). */
function dataHolders(db: Db): Set<string> {
  const ids = new Set(db.prepare('SELECT DISTINCT plugin_id FROM plugin_tables').pluck().all() as string[]);
  const keys = db.prepare(`SELECT key FROM settings WHERE substr(key, 1, length('plugin.')) = 'plugin.'`).pluck().all() as string[];
  for (const key of keys) {
    const id = PREFERENCE_KEY.exec(key)?.[1];
    if (id) ids.add(id);
  }
  return ids;
}

/** Ids whose data this profile may hold: dataHolders, and each plugin that ran (tables it made by any means stay with it). */
function holders(db: Db): Set<string> {
  const ids = dataHolders(db);
  for (const id of db.prepare('SELECT plugin_id FROM plugin_namespaces').pluck().all() as string[]) ids.add(id);
  return ids;
}

/** Table `name`'s owner as the data held shows: its one candidate id holding data, else its one candidate id; null when unclear. */
function derivedOwner(name: string, held: ReadonlySet<string>): string | null {
  const ids = tableIds(name);
  const holding = ids.filter((id) => held.has(id));
  const only = holding.length ? holding : ids;
  return only.length === 1 ? only[0]! : null;
}

/** Records plugin `id` as table `name`'s owner. */
export function recordTable(db: Db, name: string, id: string): void {
  db.prepare('INSERT OR REPLACE INTO plugin_tables (name, plugin_id) VALUES (?, ?)').run(name, id);
}

/** Records every table in running plugin `id`'s namespace as its own: claimTables let it run, so no other's is there. */
export function recordTables(db: Db, id: string): void {
  for (const name of tablesStarting(db, pluginTablePrefix(id))) recordTable(db, name, id);
}

/** Seeds the plugins that ran with those whose data the archive holds (an archive from before they were recorded). */
export function recordHolders(db: Db): void {
  const insert = db.prepare('INSERT OR IGNORE INTO plugin_namespaces (plugin_id) VALUES (?)');
  for (const id of dataHolders(db)) insert.run(id);
}

/** Seeds the records with each plugin table whose owner its name and the data held show (an archive before records). */
export function recordDerivableOwners(db: Db): void {
  const held = dataHolders(db);
  for (const name of tablesStarting(db, PLUGIN_TABLE_PREFIX)) {
    const owner = derivedOwner(name, held);
    if (owner) recordTable(db, name, owner);
  }
}

/**
 * Claims plugin `id`'s table namespace before it runs: each table there must be recorded as its own, or unrecorded with
 * no other id its name fits holding data; it is recorded so, and `id` as having run. Throws naming one that is, or may
 * be, another plugin's.
 */
export function claimTables(db: Db, id: string): void {
  const prefix = pluginTablePrefix(id);
  db.transaction(() => {
    // A dropped table's record would keep its plugin holding data and claim a later table of that name.
    db.prepare(`DELETE FROM plugin_tables WHERE name NOT IN (SELECT name FROM sqlite_master WHERE type = 'table')`).run();
    const held = holders(db);
    const recorded = db.prepare('SELECT plugin_id FROM plugin_tables WHERE name = ?').pluck();
    for (const name of tablesStarting(db, prefix)) {
      const owner = recorded.get(name) as string | undefined;
      const others = owner === undefined ? tableIds(name).filter((other) => other !== id && held.has(other)) : [owner].filter((other) => other !== id);
      if (others.length) {
        const holds = owner === undefined ? 'may hold' : 'holds';
        throw new Error(`Plugin ${id}'s tables (${prefix}…) would include ${name}, which ${holds} plugin ${others.join(' or ')}'s data; a removed plugin's tables stay.`);
      }
      recordTable(db, name, id);
    }
    db.prepare('INSERT OR IGNORE INTO plugin_namespaces (plugin_id) VALUES (?)').run(id);
  })();
}
