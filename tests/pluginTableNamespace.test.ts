// Plugin table names: `p_<id, dashes as underscores>_<name>` can't say where the id ends, so plugins loaded together
// must not have nesting ids (foo, foo-bar); then each (plugin, local name) pair names its own table. A removed plugin's
// tables stay, so a plugin also runs only while every table in its namespace is its own (plugin_tables).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { definePlugin } from '@plugin-sdk/shared';
import { checkBundled } from '@shared/bundledCheck';
import { pluginTableName, tableNamespacesNest } from '@shared/bundledTypes';
import { acceptInstalled } from '@shared/installedCheck';
import { PLUGIN_API_VERSION } from '@shared/plugins';
import { setSetting, type Db } from '../src/core/db';
import { PluginHost } from '../src/core/plugins/host';
import { recordDerivableOwners } from '../src/core/plugins/tableOwners';
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

describe('plugin table owners', () => {
  const FOO_BAR = "export function activate(api) { const t = api.db.table('items'); api.db.migrate([`CREATE TABLE ${t} (v TEXT)`]); api.db.prepare(`INSERT INTO ${t} VALUES ('foo-bar state')`).run(); }";
  const FOO = "export function activate(api) { const t = api.db.table('bar_items'); api.db.migrate([`CREATE TABLE IF NOT EXISTS ${t} (v TEXT)`]); api.db.prepare(`INSERT INTO ${t} VALUES ('foo state')`).run(); }";
  const SHARED = 'p_foo_bar_items';
  const write = (dir: string, id: string, main: string): void => {
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(join(dir, id, 'plugin.json'), JSON.stringify({ id, version: '1.0.0', apiVersion: PLUGIN_API_VERSION, main: 'main.mjs' }));
    writeFileSync(join(dir, id, 'main.mjs'), main);
  };
  const statuses = async (dir: string, db: Db): Promise<unknown[]> => {
    const host = new PluginHost(dir, { db, emit: () => undefined, changed: () => undefined, ai: async () => ({ text: '' }), decider: () => null });
    await host.loadAll();
    host.endActivations();
    return host.list().map((p) => [p.id, p.status, p.error]);
  };
  const rows = (db: Db): unknown[] => db.prepare(`SELECT v FROM ${SHARED}`).pluck().all();
  const HELD = (owner: string): RegExp => new RegExp(`would include ${SHARED}, which holds plugin ${owner}'s data`);

  it("refuse a plugin whose namespace holds a removed plugin's table: its data stays as it was", async () => {
    const dir = tempDir();
    const db = tempDb();
    write(dir, 'foo-bar', FOO_BAR);
    expect(await statuses(dir, db)).toEqual([['foo-bar', 'active', null]]);
    rmSync(join(dir, 'foo-bar'), { recursive: true });
    write(dir, 'foo', FOO);
    expect(await statuses(dir, db)).toEqual([['foo', 'error', expect.stringMatching(HELD('foo-bar'))]]);
    expect(rows(db)).toEqual(['foo-bar state']);
  });

  it('refuse, the other way round, a plugin whose namespace holds a shorter id’s table', async () => {
    const dir = tempDir();
    const db = tempDb();
    write(dir, 'foo', FOO);
    expect(await statuses(dir, db)).toEqual([['foo', 'active', null]]);
    rmSync(join(dir, 'foo'), { recursive: true });
    write(dir, 'foo-bar', FOO_BAR);
    expect(await statuses(dir, db)).toEqual([['foo-bar', 'error', expect.stringMatching(HELD('foo'))]]);
    expect(rows(db)).toEqual(['foo state']);
  });

  it('run a plugin again over its own recorded tables, whatever else the profile holds', async () => {
    const dir = tempDir();
    const db = tempDb();
    write(dir, 'foo', FOO);
    await statuses(dir, db);
    setSetting(db, 'plugin.foo-bar.$schemaVersion', 1);
    expect(await statuses(dir, db)).toEqual([['foo', 'active', null]]);
    expect(rows(db)).toEqual(['foo state', 'foo state']);
  });

  it('derive the owner of a table from before the records: its one data-holding candidate, else refuse', async () => {
    const dir = tempDir();
    const db = tempDb();
    write(dir, 'foo', FOO);
    db.exec(`CREATE TABLE ${SHARED} (v TEXT); INSERT INTO ${SHARED} VALUES ('legacy')`);
    setSetting(db, 'plugin.foo-bar.$schemaVersion', 1);
    expect(await statuses(dir, db)).toEqual([['foo', 'error', expect.stringMatching(`would include ${SHARED}, which may hold plugin foo-bar's data`)]]);
    db.prepare(`DELETE FROM settings WHERE key = 'plugin.foo-bar.$schemaVersion'`).run();
    expect(await statuses(dir, db)).toEqual([['foo', 'active', null]]);
    expect(rows(db)).toEqual(['legacy', 'foo state']);
  });

  it('are seeded from the tables an archive held before them, where the data held shows the owner', () => {
    const db = tempDb();
    db.exec(`CREATE TABLE ${SHARED} (v TEXT); CREATE TABLE p_solo_rows (v TEXT); CREATE TABLE p_xy_zw_rows (v TEXT)`);
    setSetting(db, 'plugin.foo-bar.$schemaVersion', 1);
    recordDerivableOwners(db);
    expect(db.prepare('SELECT name, plugin_id FROM plugin_tables ORDER BY name').raw().all()).toEqual([
      [SHARED, 'foo-bar'],
      ['p_solo_rows', 'solo'],
    ]);
  });
});
