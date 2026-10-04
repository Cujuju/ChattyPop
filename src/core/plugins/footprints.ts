// Plugins whose data the archive and profile hold but that this ChattyPop doesn't load (first-start restore, §16).
import { existsSync, readdirSync } from 'node:fs';
import { tableIds, type AbsentPlugin, type FootprintKind } from '@shared/pluginRestore';
import { PLUGIN_ID_PATTERN } from '@shared/plugins';
import { ruleKindPlugin } from '@shared/ruleAvailability';
import { upgradeRuleSpec } from '@shared/ruleUpgrade';
import { isObj } from '@shared/normalize';
import { getSetting, type Db } from '../db';
import { CONTINUITY_KEY } from './continuity';
import { PLUGINS_DISABLED_KEY } from './host';

/** A plugin preference's stored key: plugin.<id>.<name> (pluginSettingKey). */
const PREFERENCE_KEY = /^plugin\.([^.]+)\./;
/** A plugin-managed rule's key: <plugin id>.<local key> (managedRuleKey); host-managed keys have no dot. */
const MANAGED_RULE_KEY = /^([^.]+)\./;

type Found = Map<string, Set<FootprintKind>>;

/** Footprints that name their id: preferences, data folders, rule parts and managed rules, on/off state. */
function namedFootprints(db: Db, dataRoot: string, add: (id: string | null | undefined, kind: FootprintKind) => void): void {
  for (const { key } of db.prepare(`SELECT key FROM settings WHERE key LIKE 'plugin.%'`).all() as { key: string }[]) add(PREFERENCE_KEY.exec(key)?.[1], 'preference');
  if (existsSync(dataRoot)) for (const e of readdirSync(dataRoot, { withFileTypes: true })) if (e.isDirectory()) add(e.name, 'dataDir');
  for (const { spec, builtin } of db.prepare('SELECT spec, builtin FROM rules').all() as { spec: string; builtin: string | null }[]) {
    add(builtin && MANAGED_RULE_KEY.exec(builtin)?.[1], 'rule');
    try {
      const s = upgradeRuleSpec(spec, builtin);
      for (const part of [s.trigger, ...s.match, ...s.narrow, ...s.actions]) add(ruleKindPlugin(part.type), 'rule');
    } catch {
      // An unreadable rule names no plugin.
    }
  }
  const disabled = getSetting(db, PLUGINS_DISABLED_KEY);
  if (Array.isArray(disabled)) for (const id of disabled) if (typeof id === 'string') add(id, 'state');
  const continuity = getSetting(db, CONTINUITY_KEY);
  if (isObj(continuity) && isObj(continuity['active'])) for (const id of Object.keys(continuity['active'])) add(id, 'state');
}

/**
 * Plugins not in `loaded` with tables, preferences, data folder, rule parts or on/off state remaining. Multi-match
 * tables go to longest loaded or data-holding id; with none, list all candidates.
 */
export function absentPlugins(db: Db, dataRoot: string, loaded: Iterable<string>): AbsentPlugin[] {
  const known = new Set(loaded);
  const found: Found = new Map();
  const add = (id: string | null | undefined, kind: FootprintKind): void => {
    if (id && PLUGIN_ID_PATTERN.test(id) && !known.has(id)) found.set(id, (found.get(id) ?? new Set()).add(kind));
  };
  namedFootprints(db, dataRoot, add);
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'p\\_%' ESCAPE '\\'`).all() as { name: string }[];
  const candidates = tables.map(({ name }) => tableIds(name)).filter((ids) => ids.length);
  // Tables that fit one id first, so they can claim a longer name that also fits a longer id.
  for (const ids of candidates) if (ids.length === 1) add(ids[0], 'table');
  const unclaimed = new Map<string, string[]>();
  for (const ids of candidates) {
    if (ids.length === 1) continue;
    const owner = [...ids].reverse().find((id) => known.has(id) || found.has(id));
    if (owner === undefined) unclaimed.set(ids.join(), ids);
    else add(owner, 'table');
  }
  const absent: AbsentPlugin[] = [...found].map(([id, kinds]) => ({ ids: [id], kinds: [...kinds].sort() }));
  for (const ids of unclaimed.values()) absent.push({ ids, kinds: ['table'] });
  return absent.sort((a, b) => a.ids[0]!.localeCompare(b.ids[0]!));
}
