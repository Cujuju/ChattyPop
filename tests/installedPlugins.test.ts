// Installed plugins at main's start (docs/plugin-architecture.md §16): staged changes applied crash-safely, each plugin
// accepted or refused with its reason, host modules published, and the boot never loading the plugin registry.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as sharedSdk from '@plugin-sdk/shared';
import build from 'virtual:bundled-plugins/shared';
import hostExports from 'virtual:installed-plugins/host-exports';
import type { PluginDescriptor } from '@shared/bundledTypes';
import { hostModules } from '@shared/hostModules';
import { HELD_DIR, REMOVED_DIR, STAGED_DIR, TRASH_DIR } from '@shared/installedPlugins';
import { prepareInstalled } from '../src/main/plugins/installed/boot';
import { applyStaged } from '../src/main/plugins/installed/staged';
import { host, installedRoot, sharedModule, writePlugin } from './installedFixtures';
import { ROOT, closure, importsOf } from './rendererGraph';

// @plugin-sdk/main's modules reach Electron when they load; these tests only read its export names.
vi.mock('electron', () => ({ app: { getPath: () => '' }, dialog: {}, ipcMain: { handle: () => undefined } }));

const versionOf = (dir: string): string => (JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as { version: string }).version;
const noErrors = (id: string, err: unknown): never => {
  throw new Error(`${id}: ${String(err)}`);
};

describe('staged changes', () => {
  const staged = (root: string, id: string, version: string): string => writePlugin(join(root, STAGED_DIR), id, { manifest: { version } });
  const marker = (root: string, id: string): void => {
    mkdirSync(join(root, REMOVED_DIR), { recursive: true });
    writeFileSync(join(root, REMOVED_DIR, id), '');
  };
  /** What the folder holds after a start: installed ids with versions, and what is left of the installer's folders. */
  const state = (root: string): Record<string, string> =>
    Object.fromEntries(
      readdirSync(root).flatMap((name) => {
        if (!name.startsWith('.')) return [[name, versionOf(join(root, name))]];
        const left = readdirSync(join(root, name));
        return left.length ? [[name, left.join(',')]] : [];
      }),
    );

  it('installs, updates and removes, emptying the trash; a second start changes nothing', () => {
    const root = installedRoot();
    writePlugin(root, 'kept', { manifest: { version: '1.0.0' } });
    writePlugin(root, 'updated', { manifest: { version: '1.0.0' } });
    writePlugin(root, 'removed');
    staged(root, 'added', '1.0.0');
    staged(root, 'updated', '2.0.0');
    marker(root, 'removed');
    applyStaged(root, noErrors);
    const after = { added: '1.0.0', kept: '1.0.0', updated: '2.0.0' };
    expect(state(root)).toEqual(after);
    expect(existsSync(join(root, TRASH_DIR))).toBe(false);
    applyStaged(root, noErrors);
    expect(state(root)).toEqual(after);
  });

  it('completes an update a crash interrupted after the old copy went to the trash', () => {
    const root = installedRoot();
    writePlugin(join(root, TRASH_DIR), 'app', { manifest: { version: '1.0.0' } });
    staged(root, 'app', '2.0.0');
    applyStaged(root, noErrors);
    expect(state(root)).toEqual({ app: '2.0.0' });
  });

  it('finishes a removal whose folder is already gone, and empties a trash an earlier start left', () => {
    const root = installedRoot();
    marker(root, 'gone');
    writePlugin(root, 'app', { manifest: { version: '2.0.0' } });
    writePlugin(join(root, TRASH_DIR), 'app');
    applyStaged(root, noErrors);
    expect(state(root)).toEqual({ app: '2.0.0' });
  });

  it('trashes beside a copy an earlier start could not delete, and leaves other names alone', () => {
    const root = installedRoot();
    writePlugin(root, 'app', { manifest: { version: '1.0.0' } });
    writePlugin(join(root, TRASH_DIR), 'app');
    staged(root, 'app', '2.0.0');
    mkdirSync(join(root, STAGED_DIR, 'Not An Id'));
    mkdirSync(join(root, '.incoming', 'work'), { recursive: true });
    applyStaged(root, noErrors);
    expect(state(root)).toEqual({ app: '2.0.0', [STAGED_DIR]: 'Not An Id', '.incoming': 'work' });
  });

  it('puts back a held staged copy whose replacement a crash lost, and deletes one whose replacement is staged', () => {
    const root = installedRoot();
    writePlugin(join(root, HELD_DIR), 'lost', { manifest: { version: '1.0.0' } });
    writePlugin(join(root, HELD_DIR), 'swapped', { manifest: { version: '1.0.0' } });
    staged(root, 'swapped', '2.0.0');
    applyStaged(root, noErrors);
    expect(state(root)).toEqual({ lost: '1.0.0', swapped: '2.0.0' });
  });

  it("holds back a plugin's staged install while its removal marker can't be deleted, so the marker can't remove it later", () => {
    const root = installedRoot();
    writePlugin(root, 'app', { manifest: { version: '1.0.0' } });
    staged(root, 'app', '2.0.0');
    // A folder where the marker file should be: deleting it as a file fails, as a held-open file would.
    mkdirSync(join(root, REMOVED_DIR, 'app', 'x'), { recursive: true });
    const failed: string[] = [];
    applyStaged(root, (id) => void failed.push(id));
    expect(failed).toEqual(['app']);
    expect(existsSync(join(root, STAGED_DIR, 'app'))).toBe(true);
    expect(existsSync(join(root, 'app'))).toBe(false);
  });
});

describe('accepting installed plugins', () => {
  /** A plugin the build includes. */
  const BUILT = sharedSdk.definePlugin({ manifest: { id: 'built', name: 'Built', version: '1.0.0', description: '' } });
  /** Runs `f` with BUILT in the build's descriptors, as main's start reads them. */
  const withBuilt = <T>(f: () => T): T => {
    const list = build as PluginDescriptor[];
    list.push(BUILT);
    try {
      return f();
    } finally {
      list.splice(list.indexOf(BUILT), 1);
    }
  };
  const start = (root: string) => {
    const log: string[] = [];
    const decided = prepareInstalled(root, (event, detail) => void log.push(`${event} ${String(detail['pluginId'])}`));
    const refused = Object.fromEntries(decided.refused.map((r) => [r.id, r.error]));
    return { accepted: decided.accepted.map((p) => p.manifest.id), refused, decided, log };
  };

  it('accepts in id order after applying staged installs, reading where each came from', () => {
    const root = installedRoot();
    writePlugin(root, 'beta');
    writePlugin(join(root, STAGED_DIR), 'alpha');
    writeFileSync(join(root, STAGED_DIR, 'alpha', 'source.json'), JSON.stringify({ kind: 'local', path: 'C:/p', installedAt: 1 }));
    writePlugin(join(root, '.incoming'), 'gamma'); // the installer's work folder
    const { accepted, decided, refused } = start(root);
    expect([accepted, refused]).toEqual([['alpha', 'beta'], {}]);
    expect(decided.accepted[0]).toMatchObject({ dir: join(root, 'alpha'), source: { kind: 'local', path: 'C:/p' } });
    expect(decided.accepted[1]!.source).toBeNull();
  });

  it('refuses from the manifest alone, before running its code', () => {
    const root = installedRoot();
    const ran = (id: string): string => `globalThis.ranInstalled = [...(globalThis.ranInstalled ?? []), '${id}'];\n${sharedModule(id)}`;
    writePlugin(root, 'nomanifest');
    writeFileSync(join(root, 'nomanifest', 'plugin.json'), '{');
    writePlugin(root, 'oldformat', { manifest: { format: 2 }, shared: ran('oldformat') });
    writePlugin(root, 'elsewhere', { manifest: { id: 'other' }, shared: ran('elsewhere') });
    writePlugin(root, BUILT.manifest.id, { shared: ran(BUILT.manifest.id) });
    writePlugin(root, 'nextmajor', { manifest: { sdk: '3.0.0' }, shared: ran('nextmajor') });
    writePlugin(root, 'newerminor', { manifest: { sdk: '2.99.0' }, shared: ran('newerminor') });
    const imports = { '@plugin-sdk/shared': ['definePlugin', 'gone'], '@plugin-sdk/core': ['defineCorePlugin', 'removed'], '@plugin-sdk/main': ['defineMainPlugin'], '@plugin-sdk/renderer': ['browserOnly'] };
    writePlugin(root, 'missing', { manifest: { hostImports: imports }, shared: ran('missing') });
    const { accepted, refused, log } = withBuilt(() => start(root));
    expect(accepted).toEqual([]);
    expect(refused['nomanifest']).toMatch(/JSON/);
    expect(refused['oldformat']).toMatch(/format 2 is not 1/);
    expect(refused['elsewhere']).toBe('plugin.json names other, but its folder is elsewhere.');
    expect(refused[BUILT.manifest.id]).toBe(`ChattyPop already includes plugin ${BUILT.manifest.id}.`);
    expect(refused['nextmajor']).toMatch(/Rebuild it for SDK 2/);
    expect(refused['newerminor']).toMatch(/Update ChattyPop/);
    // Node modules only: the browser tiers are the windows' to check.
    expect(refused['missing']).toBe("imports what this ChattyPop doesn't provide (@plugin-sdk/shared: gone, @plugin-sdk/core: removed). Update ChattyPop or the plugin.");
    expect((globalThis as { ranInstalled?: string[] }).ranInstalled).toBeUndefined();
    expect(log).toContain('installed-plugin-refused missing');
  });

  it("refuses by its descriptor beside the build's and those accepted before it; a throw refuses that plugin alone", () => {
    const root = installedRoot();
    const panel = (id: string, after?: string): string => `panels: [{ id: '${id}', title: 'P', importance: 'reference', dialog: false, iconPath: ''${after ? `, after: '${after}'` : ''} }]`;
    writePlugin(root, 'aaa', { shared: sharedModule('aaa', panel('shared-panel')) });
    writePlugin(root, 'bbb', { shared: sharedModule('bbb', panel('shared-panel')) });
    // A typo on a plugin that is here; an unstamped anchor nothing here declares may be a plugin not installed.
    writePlugin(root, 'ccc', { shared: sharedModule('ccc', "slots: { messageMenu: [{ id: 'menu', after: 'aaa.nowhere' }] }") });
    writePlugin(root, 'ddd', { shared: sharedModule('someone') });
    writePlugin(root, 'eee', { shared: 'export default 42;' });
    writePlugin(root, 'fff', { shared: "throw new Error('fff failed to load');" });
    writePlugin(root, 'ggg', { shared: sharedModule('ggg', panel('ggg-panel', 'shared-panel')) });
    writePlugin(root, 'hhh', { shared: sharedModule('hhh', panel('hhh-panel', 'absent-panel')) });
    // A typo on a plugin accepted after it refuses the one with the typo, not its target.
    writePlugin(root, 'iii', { shared: sharedModule('iii', "slots: { messageMenu: [{ id: 'menu', after: 'jjj.nowhere' }] }") });
    writePlugin(root, 'jjj', { shared: sharedModule('jjj') });
    const { accepted, refused } = start(root);
    expect(accepted).toEqual(['aaa', 'ggg', 'hhh', 'jjj']);
    expect(refused).toEqual({
      bbb: 'Two bundled plugins provide panel shared-panel',
      ccc: expect.stringMatching(/aaa.nowhere, which no plugin provides/),
      ddd: 'its descriptor is plugin someone, not ddd.',
      eee: 'its shared module must export its descriptor (definePlugin) as default.',
      fff: 'fff failed to load',
      iii: expect.stringMatching(/jjj.nowhere, which no plugin provides/),
    });
  });

  it("publishes the shared SDK tier before loading plugins; checks core's and main's by their export names", async () => {
    const root = installedRoot();
    writePlugin(root, 'reader', { shared: `export const seen = ${host('@plugin-sdk/shared')}.definePlugin;\n${sharedModule('reader')}` });
    expect(start(root).accepted).toEqual(['reader']);
    expect(hostModules()['@plugin-sdk/shared']).toBe(sharedSdk);
    // The names the build reads from source are what those modules export at run time.
    const keys = async (mod: Promise<object>): Promise<string[]> => Object.keys(await mod).sort();
    expect([...hostExports['@plugin-sdk/core']!].sort()).toEqual(await keys(import('@plugin-sdk/core')));
    expect([...hostExports['@plugin-sdk/main']!].sort()).toEqual(await keys(import('@plugin-sdk/main')));
  });
});

describe('the boot never loads the plugin registry', () => {
  const REGISTRY = resolve(ROOT, 'src/shared/bundledPlugins.ts');
  const BOOT = resolve(ROOT, 'src/main/index.ts');
  const APP = resolve(ROOT, 'src/main/app.ts');

  it.each(['src/plugin-sdk/shared/index.ts', 'src/shared/bundledCheck.ts', 'src/shared/installedCheck.ts', 'src/main/plugins/installed/boot.ts'])('%s', (file) => {
    expect(closure([resolve(ROOT, file)]).has(REGISTRY)).toBe(false);
  });

  it('main runs everything before importing the app without it', () => {
    const before = importsOf(BOOT);
    expect(before).toContain(APP);
    expect(closure(before.filter((f) => f !== APP)).has(REGISTRY)).toBe(false);
  });
});
