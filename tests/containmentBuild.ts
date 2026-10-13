import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, type Plugin } from 'vite';
import solid from 'vite-plugin-solid';
import { tempDir } from './helpers';

const ROOT = join(import.meta.dirname, '..');
export const CONTAINMENT_ADAPTER = join(import.meta.dirname, 'sectionSplitHarness.ts').replaceAll('\\', '/');
const ENTRY = join(ROOT, 'tests/virtual-containment.tsx').replaceAll('\\', '/');

/** Builds renderer code with client Solid and the existing universal tree adapter. */
export async function buildContainment<T>(source: string, stubs: Record<string, string> = {}): Promise<T> {
  const output = tempDir();
  const modules = new Map(Object.entries(stubs).map(([id, text], i) => [id, { id: `test:containment-${i}`, text }]));
  const fixture: Plugin = {
    name: 'containment-fixture',
    resolveId: (id) => /virtual-containment\.tsx$/.test(id) ? ENTRY : [...modules.values()].find((m) => m.id === id)?.id,
    load: (id) => id === ENTRY ? source : [...modules.values()].find((m) => m.id === id)?.text,
  };
  await build({
    root: ROOT, configFile: false, logLevel: 'silent',
    plugins: [fixture, solid({ hot: false, dev: false, solid: { generate: 'universal', moduleName: CONTAINMENT_ADAPTER } })],
    resolve: { alias: [
      ...[...modules].map(([find, m]) => ({ find, replacement: m.id })),
      { find: '@plugin-sdk', replacement: join(ROOT, 'src/plugin-sdk') },
      { find: '@shared', replacement: join(ROOT, 'src/shared') },
      { find: '@', replacement: join(ROOT, 'src/renderer/src') },
      { find: /^solid-js$/, replacement: join(ROOT, 'node_modules/solid-js/dist/solid.js') },
      { find: /^solid-js\/store$/, replacement: join(ROOT, 'node_modules/solid-js/store/dist/store.js') },
      { find: /^solid-js\/web$/, replacement: join(ROOT, 'node_modules/solid-js/web/dist/web.js') },
    ] },
    ssr: { noExternal: true },
    build: { ssr: ENTRY, outDir: output, rollupOptions: { output: { entryFileNames: 'containment.mjs' } } },
  });
  return import(pathToFileURL(join(output, 'containment.mjs')).href) as Promise<T>;
}
