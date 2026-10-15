// Plugin table names: `p_<id, dashes as underscores>_<name>` can't say where the id ends, so plugins loaded together
// must not have nesting ids (foo, foo-bar); then each (plugin, local name) pair names its own table.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { definePlugin } from '@plugin-sdk/shared';
import { checkBundled } from '@shared/bundledCheck';
import { pluginTableName, tableNamespacesNest } from '@shared/bundledTypes';
import { acceptInstalled } from '@shared/installedCheck';
import { PLUGIN_API_VERSION } from '@shared/plugins';
import { PluginHost } from '../src/core/plugins/host';
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
