// Plugin table names: `p_<id, dashes as underscores>_<name>` can't say where the id ends, so plugins loaded together
// must not have nesting ids (foo, foo-bar); then each (plugin, local name) pair names its own table. A removed plugin's
// tables stay, so a profile also keeps every id that ran (plugin_namespaces), and no id nesting with one of them runs.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { definePlugin } from '@plugin-sdk/shared';
import { testPlugin } from '@plugin-sdk/core/testing';
import { checkBundled } from '@shared/bundledCheck';
import { pluginTableName, tableNamespacesNest } from '@shared/bundledTypes';
import { acceptInstalled } from '@shared/installedCheck';
import { PLUGIN_API_VERSION } from '@shared/plugins';
import type { Db } from '../src/core/db';
import { PluginHost } from '../src/core/plugins/host';
import { reserveTableOwners } from '../src/core/laterMigrations';
import { tempDb, tempDir } from './helpers';

const plugin = (id: string) => definePlugin({ manifest: { id, name: id, version: '1.0.0', description: '' } });
const NESTING = /tables \(p_foo_…\) would share names with plugin foo-bar's \(p_foo_bar_…\)|tables \(p_foo_bar_…\) would share names with plugin foo's \(p_foo_…\)/;

describe('plugin table namespaces', () => {
  it('nest exactly when one id is the other followed by a dash, at any depth', () => {
    expect(pluginTableName('foo-bar', 'items')).toBe(pluginTableName('foo', 'bar_items'));
    expect(pluginTableName('my-plug-in', 'x')).toBe(pluginTableName('my', 'plug_in_x'));
    expect(tableNamespacesNest('foo', 'foo-bar')).toBe(true);
    expect(tableNamespacesNest('my-plug-in', 'my')).toBe(true);
    expect(tableNamespacesNest('my-plug', 'my-plug-in')).toBe(true);
    expect(tableNamespacesNest('foo', 'foobar')).toBe(false);
    expect(tableNamespacesNest('foo-bar', 'foo-baz')).toBe(false);
    expect(tableNamespacesNest('foo', 'foo')).toBe(false);
  });

  it('refuse a build holding both, whichever order', () => {
    expect(() => checkBundled([plugin('foo-bar'), plugin('foo')])).toThrow(NESTING);
    expect(() => checkBundled([plugin('foo'), plugin('foo-bar')])).toThrow(NESTING);
    expect(() => checkBundled([plugin('foo'), plugin('foobar'), plugin('fop-baz-qux')])).not.toThrow();
  });

  it("refuse both in the SDK's test host, as the app does", () => {
    expect(() => testPlugin(plugin('foo'), { with: [plugin('foo-bar')] })).toThrow(NESTING);
  });

  it('refuse the installed plugin whose namespace nests in one already kept; the rest are kept', () => {
    const { kept, refused } = acceptInstalled([plugin('built')], null, [plugin('foo'), plugin('foo-bar'), plugin('other')], (p) => p);
    expect(kept.map((p) => p.manifest.id)).toEqual(['foo', 'other']);
    expect(refused.map((r) => [r.candidate.manifest.id, String(r.error)])).toEqual([['foo-bar', expect.stringMatching(NESTING)]]);
  });

  it('refuse a folder plugin whose namespace nests in a loaded one, before it runs', async () => {
    const dir = tempDir();
    for (const id of ['foo', 'foo-bar']) {
      mkdirSync(join(dir, id), { recursive: true });
      writeFileSync(join(dir, id, 'plugin.json'), JSON.stringify({ id, version: '1.0.0', apiVersion: PLUGIN_API_VERSION, main: 'main.mjs' }));
      writeFileSync(join(dir, id, 'main.mjs'), 'export function activate(api) { globalThis.nestedRan = [...(globalThis.nestedRan ?? []), api.db.table("items")]; }');
    }
    onTestFinished(() => void delete (globalThis as { nestedRan?: string[] }).nestedRan);
    const host = new PluginHost(dir, { db: tempDb(), emit: () => undefined, changed: () => undefined, ai: async () => ({ text: '' }), decider: () => null });
    await host.loadAll();
    expect(host.list().map((p) => [p.id, p.status, p.error])).toEqual([
      ['foo', 'active', null],
      ['foo-bar', 'error', expect.stringMatching(NESTING)],
    ]);
    expect((globalThis as { nestedRan?: string[] }).nestedRan).toEqual(['p_foo_items']);
  });
});

describe('plugin ids that ran', () => {
  /** Plugin `id`'s table `local`, made by migrate or db.prepare (`how`), with one row added each run. */
  const STORES = (local: string, row: string, how: 'migrate' | 'prepare', after = ''): string => {
    const create = how === 'migrate' ? "api.db.migrate([`CREATE TABLE IF NOT EXISTS ${t} (v TEXT)`]);" : "api.db.prepare(`CREATE TABLE IF NOT EXISTS ${t} (v TEXT)`).run();";
    return `export function activate(api) { const t = api.db.table('${local}'); ${create} api.db.prepare(\`INSERT INTO \${t} VALUES ('${row}')\`).run(); ${after} }`;
  };
  const SHARED = 'p_foo_bar_items';
  const write = (dir: string, id: string, main: string): void => {
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(join(dir, id, 'plugin.json'), JSON.stringify({ id, version: '1.0.0', apiVersion: PLUGIN_API_VERSION, main: 'main.mjs' }));
    writeFileSync(join(dir, id, 'main.mjs'), main);
  };
  /** One app start over `db` with the plugins in `dir`: each plugin's id, status and error. */
  const start = async (dir: string, db: Db): Promise<unknown[]> => {
    const host = new PluginHost(dir, { db, emit: () => undefined, changed: () => undefined, ai: async () => ({ text: '' }), decider: () => null });
    await host.loadAll();
    await host.endActivations();
    return host.list().map((p) => [p.id, p.status, p.error]);
  };
  /** Runs `earlier` (its main), removes it, then starts `later` (its main): `later`'s listing. */
  const takeover = async (db: Db, earlier: [string, string], later: [string, string]): Promise<unknown[]> => {
    const dir = tempDir();
    write(dir, ...earlier);
    expect(await start(dir, db)).toEqual([[earlier[0], 'active', null]]);
    rmSync(join(dir, earlier[0]), { recursive: true });
    write(dir, ...later);
    return start(dir, db);
  };
  const rows = (db: Db, table = SHARED): unknown[] => db.prepare(`SELECT v FROM ${table}`).pluck().all();
  const RESERVED = (id: string, other: string): RegExp =>
    new RegExp(`^Plugin ${id}'s tables .* would share names with plugin ${other}'s .*, which ran in this profile: the profile keeps its data`);

  it("refuse a plugin whose id nests with a removed one's, whichever way, however its tables were made: their data stays", async () => {
    for (const how of ['migrate', 'prepare'] as const) {
      const db = tempDb();
      expect(await takeover(db, ['foo-bar', STORES('items', 'foo-bar state', how)], ['foo', STORES('bar_items', 'foo state', how)]), how)
        .toEqual([['foo', 'error', expect.stringMatching(RESERVED('foo', 'foo-bar'))]]);
      expect(rows(db)).toEqual(['foo-bar state']);
      const other = tempDb();
      expect(await takeover(other, ['foo', STORES('bar_items', 'foo state', how)], ['foo-bar', STORES('items', 'foo-bar state', how)]), how)
        .toEqual([['foo-bar', 'error', expect.stringMatching(RESERVED('foo-bar', 'foo'))]]);
      expect(rows(other)).toEqual(['foo state']);
    }
  });

  it('refuse it over a table named in capitals, or renamed into its namespace', async () => {
    const upper = tempDb();
    const capitals = "export function activate(api) { api.db.prepare(`CREATE TABLE P_FOO_BAR_ITEMS (v TEXT)`).run(); api.db.prepare(`INSERT INTO P_FOO_BAR_ITEMS VALUES ('foo-bar state')`).run(); }";
    expect(await takeover(upper, ['foo-bar', capitals], ['foo', STORES('bar_items', 'foo state', 'prepare')])).toEqual([['foo', 'error', expect.stringMatching(RESERVED('foo', 'foo-bar'))]]);
    expect(rows(upper)).toEqual(['foo-bar state']);
    const renamed = tempDb();
    const rename = STORES('items', 'foo-bar state', 'prepare', "api.db.prepare(`ALTER TABLE ${t} RENAME TO p_foo_items`).run();");
    expect(await takeover(renamed, ['foo-bar', rename], ['foo', STORES('items', 'foo state', 'prepare')])).toEqual([['foo', 'error', expect.stringMatching(RESERVED('foo', 'foo-bar'))]]);
    expect(rows(renamed, 'p_foo_items')).toEqual(['foo-bar state']);
  });

  it('refuse a plugin whose id nests with one that ran without tables', async () => {
    const db = tempDb();
    expect(await takeover(db, ['foo', 'export function activate() {}'], ['foo-bar', STORES('items', 'foo-bar state', 'prepare')]))
      .toEqual([['foo-bar', 'error', expect.stringMatching(RESERVED('foo-bar', 'foo'))]]);
    expect(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = '${SHARED}'`).get()).toBeUndefined();
  });

  it('run a plugin again over its own tables, however made, at every start', async () => {
    for (const how of ['migrate', 'prepare'] as const) {
      const dir = tempDir();
      const db = tempDb();
      write(dir, 'foo', STORES('bar_items', 'foo state', how));
      for (let run = 0; run < 3; run++) expect(await start(dir, db), how).toEqual([['foo', 'active', null]]);
      expect(rows(db)).toEqual(['foo state', 'foo state', 'foo state']);
    }
  });

  it("run whatever a table owner's record does: the records are no longer written", async () => {
    const dir = tempDir();
    const db = tempDb();
    db.exec(`CREATE TRIGGER no_records BEFORE INSERT ON plugin_tables BEGIN SELECT RAISE(ABORT, 'record failed'); END`);
    write(dir, 'foo-bar', STORES('items', 'foo-bar state', 'prepare'));
    expect(await start(dir, db)).toEqual([['foo-bar', 'active', null]]);
    expect(await start(dir, db)).toEqual([['foo-bar', 'active', null]]);
    expect(rows(db)).toEqual(['foo-bar state', 'foo-bar state']);
  });

  it('record an id before it runs, with the check: a failed record runs nothing', async () => {
    const dir = tempDir();
    const db = tempDb();
    db.exec(`CREATE TRIGGER no_ids BEFORE INSERT ON plugin_namespaces BEGIN SELECT RAISE(ABORT, 'record failed'); END`);
    write(dir, 'foo-bar', STORES('items', 'foo-bar state', 'prepare'));
    expect(await start(dir, db)).toEqual([['foo-bar', 'error', 'record failed']]);
    expect(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = '${SHARED}'`).get()).toBeUndefined();
    db.exec('DROP TRIGGER no_ids');
    expect(await start(dir, db)).toEqual([['foo-bar', 'active', null]]);
  });

  it('are seeded with the owners of the tables recorded before ids were', () => {
    const db = tempDb();
    db.prepare('INSERT INTO plugin_tables (name, plugin_id) VALUES (?, ?)').run(SHARED, 'foo-bar');
    reserveTableOwners(db);
    expect(db.prepare('SELECT plugin_id FROM plugin_namespaces').pluck().all()).toEqual(['foo-bar']);
  });
});