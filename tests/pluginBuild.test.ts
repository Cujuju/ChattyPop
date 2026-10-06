// Plugin builds produce plugin.json plus node/browser modules using host namespaces. Unsupported plugins fail during build.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HOST_MODULES_KEY, manifestFiles, parseInstalledManifest, type InstalledManifest } from '@shared/installedPlugins';
import type { PluginDescriptor } from '@shared/bundledTypes';
import { buildInstalledPlugin } from '@main/pluginBuild';
import { tempDir } from './helpers';

const ROOT = resolve(__dirname, '..');
/** plugin:check's fixture folder: shared, core, and a renderer with a stylesheet. */
const RENDERER_FIXTURE = resolve(ROOT, 'tests/fixtures/checkprobe');
/** A plugin with no renderer: shared and a core side through the SDK. */
const NODE_ONLY_FIXTURE = {
  'core/index.ts': "import { defineCorePlugin } from '@plugin-sdk/core';\nimport plugin from '../shared';\nexport default defineCorePlugin(plugin, () => undefined);\n",
};
const APP_VERSION = '0.9.1';
/** A build evaluates the plugin's descriptor and runs two Vite builds. */
const BUILD_TIMEOUT_MS = 120_000;

const jsFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? jsFiles(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : []));
/** Every module specifier a built file imports, statically or dynamically. */
const specifiers = (file: string): string[] =>
  [...readFileSync(file, 'utf8').matchAll(/(?:^|[\s;}])(?:import|export)\s*(?:[^'"()]*?\sfrom\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gm)].map((m) => (m[1] ?? m[2])!);

/** The folders a build compiles; a plugin's tests aren't built. */
const BUILT_SIDES = ['shared', 'core', 'main', 'renderer'];

/** Host-module names a plugin's built source imports as values (JSX's solid-js/web imports come from the compiler). */
function sourceHostImports(dir: string): Record<string, string[]> {
  const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : /\.tsx?$/.test(e.name) ? [join(d, e.name)] : []));
  const out: Record<string, Set<string>> = {};
  for (const f of BUILT_SIDES.map((side) => join(dir, side)).filter(existsSync).flatMap(files)) {
    for (const m of readFileSync(f, 'utf8').matchAll(/import\s+(?!type\s)\{([^}]*)\}\s*from\s*'(@plugin-sdk\/[^']+|solid-js[^']*)'/g)) {
      const names = m[1]!.split(',').map((s) => s.trim()).filter((s) => s && !s.startsWith('type ')).map((s) => s.split(/\s+as\s+/)[0]!);
      for (const n of names) (out[m[2]!] ??= new Set()).add(n);
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort()]));
}

/** Publishes the host's SDK namespaces as the app does at start. */
async function publishHostModules(): Promise<void> {
  (globalThis as Record<symbol, unknown>)[HOST_MODULES_KEY] = {
    '@plugin-sdk/shared': await import('@plugin-sdk/shared'),
    '@plugin-sdk/core': await import('@plugin-sdk/core'),
  };
}
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[HOST_MODULES_KEY];
});

const importBuilt = async <T>(file: string): Promise<T> => (await import(/* @vite-ignore */ pathToFileURL(file).href)) as T;
const readManifest = (dir: string): InstalledManifest => parseInstalledManifest(JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')));
/** Plain data of a descriptor, functions left out, to compare a built one with its source. */
const data = (d: PluginDescriptor): unknown => JSON.parse(JSON.stringify(d));

describe.each([
  { id: 'checkprobe', renderer: true, folder: () => RENDERER_FIXTURE },
  { id: 'fixture', renderer: false, folder: () => fixture(NODE_ONLY_FIXTURE) },
])('building $id from its folder', ({ id, renderer, folder }) => {
  let dir: string;
  let out: string;
  let manifest: InstalledManifest;
  beforeAll(async () => {
    dir = folder();
    out = join(tempDir(), id);
    manifest = await buildInstalledPlugin({ pluginDir: dir, outDir: out, appVersion: APP_VERSION, repoRoot: ROOT });
  }, BUILD_TIMEOUT_MS);

  it('writes a plugin.json the loader accepts, named by the descriptor', async () => {
    const source = (await import(/* @vite-ignore */ join(dir, 'shared/index.ts'))) as { default: PluginDescriptor };
    expect(readManifest(out)).toEqual(manifest);
    const { id: mid, name, version, description } = source.default.manifest;
    expect(manifest).toMatchObject({ id: mid, name, version, description, node: { shared: 'node/shared.js', core: 'node/core.js' }, browser: { shared: 'browser/shared.js' } });
    for (const f of [...Object.values(manifest.node), manifest.browser.shared, ...(manifest.browser.renderer ? [manifest.browser.renderer] : []), ...manifest.browser.styles]) expect(existsSync(join(out, f)), f).toBe(true);
  });

  it('imports only its own files and node: built-ins from node code, and only its own files from browser code', () => {
    for (const f of jsFiles(join(out, 'node'))) for (const s of specifiers(f)) expect(s.startsWith('./') || s.startsWith('../') || s.startsWith('node:'), `${f}: ${s}`).toBe(true);
    for (const f of jsFiles(join(out, 'browser'))) for (const s of specifiers(f)) expect(s.startsWith('./') || s.startsWith('../'), `${f}: ${s}`).toBe(true);
  });

  it('records the host exports its source imports', () => {
    const { 'solid-js/web': jsx, ...rest } = manifest.hostImports;
    expect(rest).toEqual(sourceHostImports(dir));
    expect(jsx !== undefined).toBe(renderer);
  });

  it('runs its node side against the host namespaces: the same descriptor as its source', async () => {
    await publishHostModules();
    const source = (await import(/* @vite-ignore */ join(dir, 'shared/index.ts'))) as { default: PluginDescriptor };
    const shared = await importBuilt<{ default: PluginDescriptor }>(join(out, 'node/shared.js'));
    const core = await importBuilt<{ default: { plugin: PluginDescriptor } }>(join(out, 'node/core.js'));
    expect(data(shared.default)).toEqual(data(source.default));
    expect(core.default.plugin).toBe(shared.default);
  });

  it.runIf(!renderer)('loads in plain Node as main does, by require, beside a package.json without a type', () => {
    writeFileSync(join(dirname(out), 'package.json'), '{}');
    const script = `globalThis[Symbol.for('chattypop.hostModules')] = { '@plugin-sdk/shared': { definePlugin: (d) => d } };
      process.stdout.write(require(${JSON.stringify(join(out, 'node/shared.js'))}).default.manifest.id);`;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    expect({ out: r.stdout, err: r.stderr }).toEqual({ out: id, err: '' });
  });

  it(renderer ? 'has a renderer module and its stylesheet' : 'has no renderer module', () => {
    expect(manifest.browser.renderer).toBe(renderer ? 'browser/renderer.js' : undefined);
    expect(manifest.browser.styles.length > 0).toBe(renderer);
  });
});

/** A plugin folder in a temp dir: `files` by path, with a minimal descriptor unless given. */
function fixture(files: Record<string, string>): string {
  const dir = join(tempDir(), 'fixture');
  const all = {
    'shared/index.ts': "import { definePlugin } from '@plugin-sdk/shared';\nexport default definePlugin({ manifest: { id: 'fixture', name: 'Fixture', version: '1.2.3', description: 'A fixture.' } });\n",
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
const coreWith = (body: string): string => `import plugin from '../shared';\n${body}\nexport default { plugin };\n`;
const buildFixture = (files: Record<string, string>): Promise<InstalledManifest> => buildInstalledPlugin({ pluginDir: fixture(files), outDir: tempDir(), appVersion: APP_VERSION });

describe('an installed-plugin build without a checkout', () => {
  it('reads the descriptor through the published host modules, with __APP_VERSION__ the building app\'s version', async () => {
    await publishHostModules();
    const manifest = await buildFixture({
      'shared/index.ts': "import { definePlugin } from '@plugin-sdk/shared';\nexport default definePlugin({ manifest: { id: 'fixture', name: 'Fixture', version: __APP_VERSION__, description: '' } });\n",
    });
    expect(manifest).toMatchObject({ id: 'fixture', version: APP_VERSION, node: { shared: 'node/shared.js' }, hostImports: { '@plugin-sdk/shared': ['definePlugin'] } });
  }, BUILD_TIMEOUT_MS);

  it('needs the host modules published to read the descriptor', async () => {
    await expect(buildFixture({})).rejects.toThrow(/hasn't published/);
  }, BUILD_TIMEOUT_MS);
});

const PAGE_SCRIPT = '<script type="module" src="./main.ts"></script>';

describe('an installed-plugin build with a page', () => {
  const HEAD = '<head><meta charset="UTF-8" /></head>';
  const lines = (...l: string[]): string => `${l.join('\n')}\n`;
  let out: string;
  let manifest: InstalledManifest;
  beforeAll(async () => {
    await publishHostModules();
    out = tempDir();
    manifest = await buildInstalledPlugin({
      pluginDir: fixture({
        'renderer/index.tsx': lines("import './both.css';", "import './side.css';", 'export default {};'),
        'page/index.html': lines('<!doctype html>', '<html>', HEAD, '<body>', `    ${PAGE_SCRIPT}`, '</body>', '</html>'),
        'page/main.ts': lines("import '../renderer/both.css';", "import './page.css';", "import { startPage } from '@plugin-sdk/renderer/shell';", 'startPage(() => null);'),
        'renderer/both.css': '.both { display: grid; }\n',
        'renderer/side.css': '.side { display: flex; }\n',
        'page/page.css': '.page { display: block; }\n',
        'page/public/sw.js': 'self;\n',
        'page/public/install/icon.png': 'png',
      }),
      outDir: out,
      appVersion: APP_VERSION,
    });
  }, BUILD_TIMEOUT_MS);
  const cssWith = (files: string[], rule: string): string[] => files.filter((f) => readFileSync(join(out, f), 'utf8').includes(rule));

  it('lists the page: its HTML, entry, stylesheets and public files, every one present', () => {
    const page = manifest.browser.page!;
    expect(page).toMatchObject({ html: 'browser/page.html', entry: 'browser/page.js', public: ['browser/public/install/icon.png', 'browser/public/sw.js'] });
    expect(readManifest(out)).toEqual(manifest);
    for (const f of manifestFiles(manifest)) expect(existsSync(join(out, f)), f).toBe(true);
    expect(manifest.hostImports['@plugin-sdk/renderer/shell']).toEqual(['startPage']);
  });

  it('gives windows every stylesheet but the page’s own, and the page those its entry reaches', () => {
    const page = manifest.browser.page!;
    expect(cssWith(page.styles, '.page')).toHaveLength(1);
    expect(cssWith(page.styles, '.both')).toHaveLength(1);
    expect(cssWith(page.styles, '.side')).toHaveLength(0);
    expect(cssWith(manifest.browser.styles, '.page')).toHaveLength(0);
    expect(cssWith(manifest.browser.styles, '.both')).toHaveLength(1);
    expect(cssWith(manifest.browser.styles, '.side')).toHaveLength(1);
  });

  it('writes the page’s HTML without its entry script, which the host loads after publishing the host modules', () => {
    expect(readFileSync(join(out, 'browser/page.html'), 'utf8')).toBe(lines('<!doctype html>', '<html>', HEAD, '<body>', '</body>', '</html>'));
    expect(readFileSync(join(out, 'browser/page.js'), 'utf8')).toContain('startPage');
  });
});

describe('an installed-plugin build refuses', () => {
  it.each([
    ['a page with no head', { 'page/index.html': '<body><script type="module" src="./main.ts"></script></body>', 'page/main.ts': '' }, /needs a <\/head>/],
    ['a page with two scripts', { 'page/index.html': `<head></head>${PAGE_SCRIPT}<script src="/x.js"></script>`, 'page/main.ts': '' }, /exactly one script/],
    ['a page with no entry script', { 'page/index.html': '<head></head>' }, /exactly one script/],
    ['a page folder without its HTML', { 'page/main.ts': '' }, /without page\/index.html/],
    ['a page linking a relative URL', { 'page/index.html': `<head><link rel="icon" href="./icon.png"></head>${PAGE_SCRIPT}`, 'page/main.ts': '' }, /links \.\/icon\.png, a relative URL/],
    ['a host internal', { 'core/index.ts': coreWith("import { PLUGIN_ID_PATTERN } from '@shared/plugins';\nconsole.log(PLUGIN_ID_PATTERN);") }, /@shared\/plugins, a host internal/],
    ['the other platform\'s host module', { 'core/index.ts': coreWith("import { look } from '@plugin-sdk/renderer/kit';\nconsole.log(look);") }, /provides only to browser code/],
    ['a module the host doesn\'t provide', { 'core/index.ts': coreWith("import { testPlugin } from '@plugin-sdk/core/testing';\nconsole.log(testPlugin);") }, /doesn't provide/],
    ['a namespace import of a host module', { 'core/index.ts': coreWith("import * as sdk from '@plugin-sdk/core';\nconsole.log(sdk);") }, /imports all of @plugin-sdk\/core/],
    ['a dynamic import of a host module', { 'core/index.ts': coreWith("export const later = () => import('@plugin-sdk/core');") }, /dynamically/],
    ['a Node built-in in browser code', { 'renderer/index.tsx': "import { readFileSync } from 'node:fs';\nexport default readFileSync;\n" }, /Node built-in, into browser code/],
    ['a relative import outside the folder', { 'core/index.ts': coreWith("import { x } from '../../outside';\nconsole.log(x);"), '../outside.ts': 'export const x = 1;\n' }, /outside the plugin folder/],
    ['a look property in its CSS', { 'renderer/A.module.css': '.a { display: grid; color: var(--cp-text-1); }\n' }, /A\.module\.css \.a \{ color: var\(--cp-text-1\) \}: look property/],
  ])('%s', async (_what, files, error) => {
    await expect(buildFixture(files)).rejects.toThrow(error);
  }, BUILD_TIMEOUT_MS);

  it('a relative import outside the folder, when the folder is named by another path to it (a junction, an 8.3 name)', async () => {
    const real = fixture({ 'core/index.ts': coreWith("import { x } from '../../outside';\nconsole.log(x);"), '../outside.ts': 'export const x = 1;\n' });
    const alias = join(tempDir(), 'alias');
    symlinkSync(real, alias, 'junction');
    await expect(buildInstalledPlugin({ pluginDir: alias, outDir: tempDir(), appVersion: APP_VERSION })).rejects.toThrow(/outside the plugin folder/);
  }, BUILD_TIMEOUT_MS);

  it('a build folder that isn\'t empty', async () => {
    const out = tempDir();
    writeFileSync(join(out, 'stale.js'), '');
    await expect(buildInstalledPlugin({ pluginDir: fixture({}), outDir: out, appVersion: APP_VERSION })).rejects.toThrow(/must be empty/);
  });
});
