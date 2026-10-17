// Plugin ids a profile reserves. A table name doesn't say where the id ends (p_foo_bar_items is foo's bar_items or
// foo-bar's items), and a removed plugin's tables stay, so every id that ran is kept, and no id nesting with one runs.
// plugin_tables (each table's owner) is no longer read: shipped migrations still seed it, and seed ids from it.
// Unreserved: tables a plugin removed before ids were recorded left, with no stored preference naming it (#237).
import { pluginTablePrefix, tableNamespacesNest } from '@shared/bundledTypes';
import { tableIds } from '@shared/pluginRestore';
import type { Db } from '../db';

/** A plugin preference's stored key, which names its id: plugin.<id>.<name> (pluginSettingKey); its schema version is one. */
export const PREFERENCE_KEY = /^plugin\.([^.]+)\./;
/** Every plugin table's name starts so (pluginTablePrefix). */
const PLUGIN_TABLE_PREFIX = 'p_';

/** Why plugin `id` can't run in a profile where `other` ran. */
const reservedError = (id: string, other: string): Error =>
  new Error(
    `Plugin ${id}'s tables (${pluginTablePrefix(id)}…) would share names with plugin ${other}'s (${pluginTablePrefix(other)}…), which ran in this profile: the profile keeps its data, so ${id} can't run here.`,
  );

/**
 * Reserves plugin `id` before it runs, refusing it while an id that ran in this profile nests with it (tableNamespacesNest),
 * whatever their tables are named. The check and the record are one transaction.
 */
export function reservePluginId(db: Db, id: string): void {
  db.transaction(() => {
    const ran = db.prepare('SELECT plugin_id FROM plugin_namespaces').pluck().all() as string[];
    const other = ran.find((ranId) => tableNamespacesNest(id, ranId));
    if (other) throw reservedError(id, other);
    db.prepare('INSERT OR IGNORE INTO plugin_namespaces (plugin_id) VALUES (?)').run(id);
  })();
}

/** Reserves `id` before data moves into its namespace (an adopted table); false, reserving nothing, while a nesting id ran. */
export function reserveForData(db: Db, id: string): boolean {
  const ran = db.prepare('SELECT plugin_id FROM plugin_namespaces').pluck().all() as string[];
  if (ran.some((ranId) => tableNamespacesNest(id, ranId))) return false;
  db.prepare('INSERT OR IGNORE INTO plugin_namespaces (plugin_id) VALUES (?)').run(id);
  return true;
}

// Seeds for the shipped migrations (pluginTableOwners, pluginNamespaces); nothing else calls them.

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

/** Table `name`'s owner as the data held shows: its one candidate id holding data, else its one candidate id; null when unclear. */
function derivedOwner(name: string, held: ReadonlySet<string>): string | null {
  const ids = tableIds(name);
  const holding = ids.filter((id) => held.has(id));
  const only = holding.length ? holding : ids;
  return only.length === 1 ? only[0]! : null;
}

/** Seeds the ids that ran with those whose data the archive holds (an archive from before they were recorded). */
export function recordHolders(db: Db): void {
  const insert = db.prepare('INSERT OR IGNORE INTO plugin_namespaces (plugin_id) VALUES (?)');
  for (const id of dataHolders(db)) insert.run(id);
}

/** Seeds plugin_tables with each plugin table whose owner its name and the data held show. */
export function recordDerivableOwners(db: Db): void {
  const held = dataHolders(db);
  const record = db.prepare('INSERT OR REPLACE INTO plugin_tables (name, plugin_id) VALUES (?, ?)');
  for (const name of tablesStarting(db, PLUGIN_TABLE_PREFIX)) {
    const owner = derivedOwner(name, held);
    if (owner) record.run(name, owner);
  }
}

