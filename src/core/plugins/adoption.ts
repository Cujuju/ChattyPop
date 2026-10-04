// Declared adoption (docs/plugin-architecture.md §7): host tables, settings, built-in rule keys and Jev switches from before a feature was a plugin, renamed into its namespace. Runs at startup for every plugin in the build, on or off, so data never depends on the switch.
import { createArchiveRefViews } from './archiveRefs';
import { managedRuleKey, pluginSettingKey, pluginTableName, stampedName, type PluginDescriptor } from '@shared/bundledTypes';
import { SETTINGS_KEYS } from '@shared/settings';
import { getSetting, setSetting, type Db } from '../db';
import { isObj } from '@shared/normalize';

/**
 * Moves stored Jev switches (the AI settings' `jev`) from their old keys to the plugin's stamped ones. The old value wins:
 * normalizing fills a stamped key with its default and any save stores it, while an old key exists only until adopted.
 */
function adoptJevFeatures(db: Db, pluginId: string, aliases: Readonly<Record<string, string>>): void {
  const ai = getSetting(db, SETTINGS_KEYS.ai);
  if (!isObj(ai) || !isObj(ai['jev'])) return;
  const jev = { ...ai['jev'] };
  const olds = Object.keys(aliases).filter((old) => Object.hasOwn(jev, old));
  if (!olds.length) return;
  for (const old of olds) {
    jev[stampedName(pluginId, aliases[old]!)] = jev[old];
    delete jev[old];
  }
  setSetting(db, SETTINGS_KEYS.ai, { ...ai, jev });
}

const tableExists = (db: Db, name: string): boolean => db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;

/** Each rename runs only while the old name exists and the new one doesn't, so running it again changes nothing. */
export function adoptBundledData(db: Db, plugins: readonly PluginDescriptor[]): void {
  for (const p of plugins) {
    const id = p.manifest.id;
    db.transaction(() => {
      for (const [old, name] of Object.entries(p.adopts?.tables ?? {})) {
        const table = pluginTableName(id, name);
        // Names are checked by checkBundled (TABLE_NAME), so they are safe to splice. Indexes and triggers follow.
        if (tableExists(db, old) && !tableExists(db, table)) db.exec(`ALTER TABLE ${old} RENAME TO ${table}`);
      }
      for (const [old, type] of Object.entries(p.adopts?.actionKinds ?? {})) {
        db.prepare('UPDATE rule_action_runs SET kind = ? WHERE kind = ?').run(type, old);
      }
      for (const [old, name] of Object.entries(p.adopts?.settings ?? {})) {
        const key = pluginSettingKey(id, name);
        db.prepare('UPDATE settings SET key = ? WHERE key = ? AND NOT EXISTS (SELECT 1 FROM settings WHERE key = ?)').run(key, old, key);
      }
      for (const { key, field, name, shared } of p.adopts?.settingFields ?? []) {
        const source = getSetting(db, key);
        if (!isObj(source) || !Object.hasOwn(source, field)) continue;
        const targetKey = pluginSettingKey(id, name);
        const saved = getSetting(db, targetKey);
        const target = isObj(saved) ? saved : {};
        if (!Object.hasOwn(target, field)) setSetting(db, targetKey, { ...target, [field]: source[field] });
        // A shared field seeds every plugin that adopts it, so it stays for the others.
        if (shared) continue;
        delete source[field];
        setSetting(db, key, source);
      }
      for (const [old, name] of Object.entries(p.adopts?.managedRules ?? {})) {
        const key = managedRuleKey(id, name);
        // The rule row, its id, armed time, the owner's edits and its alerts stay; only its managed key moves.
        db.prepare('UPDATE rules SET builtin = ? WHERE builtin = ? AND NOT EXISTS (SELECT 1 FROM rules WHERE builtin = ?)').run(key, old, key);
      }
      adoptJevFeatures(db, id, p.adopts?.jevFeatures ?? {});
      createArchiveRefViews(db, p, false);
    })();
  }
}
