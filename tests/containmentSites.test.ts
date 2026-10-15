import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { scanSolid, type SolidSite } from '../scripts/pluginScan/containment';

const ROOT = join(import.meta.dirname, '..');
const LEAF = 'src/plugin-sdk/renderer/containment.ts';
const CONTAINED = 'src/renderer/src/ui/contained.ts';
const SNAPSHOT = 'src/renderer/src/ui/snapshot.tsx';
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(dir, entry.name)) : /\.(ts|tsx)$/.test(entry.name) ? [join(dir, entry.name)] : []);
}
const inventory = ['src/renderer/src', 'src/plugin-sdk'].flatMap((dir) => files(join(ROOT, dir))).map((file) => ({
  file: relative(ROOT, file).replaceAll('\\', '/'), ...scanSolid(readFileSync(file, 'utf8')),
}));
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
