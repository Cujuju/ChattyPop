import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { containmentViolations, scanHostSolid, scanSolid, type SolidSite } from '../scripts/pluginScan/containment';
import { CONTAINMENT_EVASIONS } from './containmentEvasions';
import { tempDir } from './helpers';

const ROOT = join(import.meta.dirname, '..');
const LEAF = 'src/plugin-sdk/renderer/containment.ts';
const CONTAINED = 'src/renderer/src/ui/contained.ts';
const SNAPSHOT = 'src/renderer/src/ui/snapshot.tsx';
const REGISTRY = 'src/renderer/src/plugins/installedRenderers.ts';
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(dir, entry.name)) : /\.(ts|tsx)$/.test(entry.name) ? [join(dir, entry.name)] : []);
}
function hostInventory(root: string) {
  return files(join(root, 'src')).map((file) => ({
    file: relative(root, file).replaceAll('\\', '/'),
    ...scanHostSolid({ rel: relative(root, file).replaceAll('\\', '/'), text: readFileSync(file, 'utf8') }),
  }));
}
const inventory = hostInventory(ROOT);
function restricted(names: string[], allowed: string[]): string[] {
  return inventory.flatMap(({ file, imports }) => imports.filter((site) => names.includes(site.name) && !allowed.includes(file)).map((site) => `${file}:${site.line}: ${site.name}`));
}

it('19: only the SDK containment leaf imports raw roots, batches, cleanups and stores', () => {
  expect(restricted(['createRoot', 'batch', 'onCleanup', 'createStore', 'createMutable'], [LEAF])).toEqual([]);
});
it('20: only containment and snapshot leaves import catchError or ErrorBoundary', () => {
  expect(restricted(['catchError', 'ErrorBoundary'], [LEAF, CONTAINED, SNAPSHOT])).toEqual([]);
});
it('21: render is imported only by the three page and snapshot entries', () => {
  const allowed = ['src/renderer/src/boot.tsx', 'src/plugin-sdk/renderer/shell/page.tsx', SNAPSHOT];
  const bad = inventory.flatMap(({ file, imports }) => imports.filter((s) => s.source === 'solid-js/web' && s.name === 'render' && !allowed.includes(file)).map((s) => `${file}:${s.line}`));
  expect(bad).toEqual([]);
});
it('22: no direct Solid computation runs at module initialization', () => {
  expect(inventory.flatMap(({ file, initial }) => initial.map((site) => `${file}:${site.line}: ${site.name}`))).toEqual([]);
});

it('only the containment leaf may escape direct Solid calls', () => {
  expect(inventory.filter(({ file }) => file !== LEAF).flatMap(({ file, escapes }) => escapes.map((site) => `${file}:${site.line}: ${site.message}`))).toEqual([]);
});

it('rejects a shared barrel re-exporting a raw store in the host inventory', () => {
  const root = tempDir();
  mkdirSync(join(root, 'src/shared'), { recursive: true });
  writeFileSync(join(root, 'src/shared/store.ts'), "export { createStore } from 'solid-js/store';");
  expect(hostInventory(root)).toEqual([expect.objectContaining({
    file: 'src/shared/store.ts',
    escapes: expect.arrayContaining([expect.objectContaining({ message: 'solid-js/store: Solid is restricted to renderer and Plugin SDK sources' })]),
  })]);
});

it.each(['shared', 'core', 'main', 'preload'])('forbids every Solid entry in host src/%s', (dir) => {
  for (const source of ['solid-js', 'solid-js/store', 'solid-js/web']) {
    for (const text of [
      `import '${source}';`,
      `import { unguarded as alias } from '${source}';`,
      `import type * as Types from '${source}';`,
      `export { unguarded as alias } from '${source}';`,
      `export * from '${source}';`,
      `import('${source}');`,
      `require('${source}');`,
    ]) expect(scanHostSolid({ rel: `src/${dir}/probe.ts`, text }).escapes, text).not.toEqual([]);
  }
});

it.each(CONTAINMENT_EVASIONS)('rejects %s in host sources', (_name, source) => {
  expect(scanSolid(source).escapes.length).toBeGreaterThan(0);
});

it('allows direct imported callees, type imports and shadowed names', () => {
  const scan = scanSolid(`
    import { createMemo as memo, createEffect, type Owner } from 'solid-js';
    import type * as Solid from 'solid-js';
    function View({ createEffect: effect }) {
      const record = { createEffect: effect };
      memo(() => record.createEffect());
      createEffect(() => 1);
    }
    function shadow(memo) { return memo; }
  `);
  expect(scan.escapes).toEqual([]);
  expect(scan.initial).toEqual([]);
});

const HOST_MODULE_MAP = `
  import * as Solid from 'solid-js';
  import * as Store from 'solid-js/store';
  import { loadRenderers } from './installedLoader';
  const RENDERER_HOST_MODULES = {
    'solid-js': Solid,
    'solid-js/store': Store,
  } satisfies TierHostModules<'browser'>;
`;

it('allows raw namespaces only as registry host-module values', () => {
  expect(scanHostSolid({ rel: REGISTRY, text: HOST_MODULE_MAP + 'loadRenderers(io, shared, RENDERER_HOST_MODULES);' })).toEqual({ imports: [], initial: [], escapes: [] });
  expect(scanHostSolid({ rel: 'src/renderer/src/probe.ts', text: HOST_MODULE_MAP }).escapes).not.toEqual([]);
  expect(containmentViolations({ rel: 'renderer/installedRenderers.ts', text: HOST_MODULE_MAP })).not.toEqual([]);
});

it('rejects exporting the raw registry map declaration', () => {
  const text = HOST_MODULE_MAP.replace('const RENDERER_HOST_MODULES', 'export const RENDERER_HOST_MODULES');
  expect(scanHostSolid({ rel: REGISTRY, text }).escapes).not.toEqual([]);
});

it.each([
  "import { RENDERER_HOST_MODULES as modules } from './plugins/installedRenderers'; modules['solid-js'].batch(() => {});",
  "import * as registry from './plugins/installedRenderers'; registry.RENDERER_HOST_MODULES['solid-js/store'].createStore({});",
  "export { RENDERER_HOST_MODULES as modules } from './plugins/installedRenderers';",
])('rejects importing or re-exporting the raw registry map: %s', (text) => {
  expect(scanHostSolid({ rel: 'src/renderer/src/probe.ts', text }).escapes).not.toEqual([]);
});

it.each([
  'export { RENDERER_HOST_MODULES };',
  'export default RENDERER_HOST_MODULES;',
  'const modules = RENDERER_HOST_MODULES;',
  "RENDERER_HOST_MODULES['solid-js'].batch(() => {});",
  "RENDERER_HOST_MODULES['solid-js/store'].createStore({});",
  'Object.keys(RENDERER_HOST_MODULES);',
  'loadRenderers(io, shared, { ...RENDERER_HOST_MODULES });',
  'function other(loadRenderers) { loadRenderers(io, shared, RENDERER_HOST_MODULES); }',
])('rejects raw registry map references outside the loader argument: %s', (source) => {
  expect(scanHostSolid({ rel: REGISTRY, text: HOST_MODULE_MAP + source }).escapes).not.toEqual([]);
});

it.each([
  "import { HOST_MODULES_KEY as key } from '@shared/installedPlugins'; globalThis[key]['solid-js'].batch(() => {});",
  "import * as installed from '@shared/installedPlugins'; globalThis[installed.HOST_MODULES_KEY]['solid-js/store'].createStore({});",
  "globalThis[installed['HOST_MODULES_KEY']]['solid-js'];",
  "import { hostModules as modules } from '@shared/hostModules'; modules()['solid-js'];",
  "export { HOST_MODULES_KEY as key } from '@shared/installedPlugins';",
])('rejects raw published host modules in non-loader host files: %s', (text) => {
  expect(scanHostSolid({ rel: 'src/renderer/src/probe.ts', text }).escapes).not.toEqual([]);
});

it.each([
  'src/shared/installedPlugins.ts', 'src/shared/hostModules.ts', 'src/renderer/src/plugins/installedLoader.ts',
  'src/main/pluginBuild/descriptor.ts', 'src/main/pluginBuild/hostModules.ts',
])(
  'allows published host-module access in the installed-module loader %s', (rel) => {
    expect(scanHostSolid({ rel, text: "import { HOST_MODULES_KEY } from '@shared/installedPlugins'; globalThis[HOST_MODULES_KEY];" }).escapes).toEqual([]);
  },
);

it.each([
  'Solid.batch(() => {});',
  'Store.createStore({});',
  'Solid.createSignal(0);',
  'const run = Solid.batch;',
  'const copy = Store;',
  'const other = { "solid-js": Solid };',
  'export { Solid };',
  'export * as RawStore from "solid-js/store";',
  'export * from "solid-js";',
])('rejects namespace access and re-exports in the registry: %s', (source) => {
  expect(scanHostSolid({ rel: REGISTRY, text: HOST_MODULE_MAP + source }).escapes).not.toEqual([]);
});

const names = (sites: SolidSite[]): string[] => sites.map((s) => s.name);
it('23: the scanner handles eager IIFEs, static fields and blocks, aliases and namespace access', () => {
  const scan = scanSolid(`
    import { createMemo as memo, createEffect } from 'solid-js';
    import * as Solid from 'solid-js';
    import * as Web from 'solid-js/web';
    const immediate = (() => memo(() => 1))();
    (function () { Solid.createComputed(() => 1); }).call(null);
    class Probe {
      static field = Solid.createRenderEffect(() => 1);
      static { createEffect(() => 1); }
      field = memo(() => 1);
      method() { createEffect(() => 1); }
    }
    const lazy = () => Solid.createResource(() => 1);
    Solid.batch(() => 1); Web.render(() => null);
    const boundary = <Solid.ErrorBoundary />;
    const keyed = { [Solid.createSelector(() => 1)]() {} };
    Solid['createReaction'](() => 1);
  `);
  expect(names(scan.initial)).toEqual(['createMemo', 'createComputed', 'createRenderEffect', 'createEffect', 'createSelector', 'createReaction']);
  expect(names(scan.imports)).toContain('batch');
  expect(scan.imports).toContainEqual(expect.objectContaining({ source: 'solid-js/web', name: 'render' }));
  expect(names(scan.imports)).toContain('ErrorBoundary');
});
it('23: parameters, destructuring, lexical declarations and hoisted vars shadow imported bindings', () => {
  const scan = scanSolid(`
    import { createMemo, createEffect as effect } from 'solid-js';
    import * as Solid from 'solid-js';
    ((createMemo) => createMemo(() => 1))(() => 1);
    (({ effect }) => effect(() => 1))({ effect: () => 1 });
    { const effect = () => 1; effect(() => 1); }
    (function () { createMemo(() => 1); if (true) { var createMemo = () => 1; } })();
    (() => { const Solid = { createResource() {} }; Solid.createResource(); })();
    try { throw 1; } catch (createMemo) { createMemo(() => 1); }
    for (const effect of []) effect(() => 1);
    createMemo(() => 1); effect(() => 1); Solid.createDeferred(() => 1);
  `);
  expect(names(scan.initial)).toEqual(['createMemo', 'createEffect', 'createDeferred']);
});

it('finds raw cleanup and store aliases, namespace members and re-exports, excluding types', () => {
  const scan = scanSolid(`
    import { onCleanup as cleanup, type Owner } from 'solid-js';
    import { createStore as store } from 'solid-js/store';
    import * as Store from 'solid-js/store';
    Store.createMutable({});
    export { onCleanup as cleanup } from 'solid-js';
    export { createStore as store, type Store } from 'solid-js/store';
    export * from 'solid-js/store';
    export type * from 'solid-js';
  `);
  expect(names(scan.imports)).toEqual(['onCleanup', 'createStore', 'onCleanup', 'createStore', 'createStore', 'createMutable', 'createMutable']);
});
