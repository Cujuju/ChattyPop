// The p1 fixture plugin folders (tests/fixtures/p1Plugins), and a build's registries generated from them.
import { resolve } from 'node:path';
import { runnerImport } from 'vite';
import { bundledPlugins } from '../bundledPlugins';

export const ROOT = resolve(import.meta.dirname, '..');
/** A folder of plugin folders, as the dev loop names a plugin repo clone's. */
export const P1_PLUGIN_DIR = resolve(import.meta.dirname, 'fixtures/p1Plugins');
/** Evaluating a registry builds its plugins' descriptors and, for a partial build, the catalog; allow for a cold transform. */
export const EVALUATE_TIMEOUT_MS = 30_000;

/** Module `id` (a file or a virtual registry) as a build of `selection` from the fixture folders evaluates it on node. */
export async function evaluateFor<M>(id: string, selection?: string): Promise<M> {
  const plugin = bundledPlugins(ROOT, 'node', { dirs: P1_PLUGIN_DIR, selection });
  const { module } = await runnerImport<M>(id, {
    configFile: false,
    root: ROOT,
    logLevel: 'silent',
    resolve: {
      alias: {
        '@shared': resolve(ROOT, 'src/shared'),
        '@core': resolve(ROOT, 'src/core'),
        '@main': resolve(ROOT, 'src/main'),
        '@plugin-sdk': resolve(ROOT, 'src/plugin-sdk'),
      },
    },
    plugins: [plugin],
  });
  return module;
}

/** The shared registry as a build choosing `selection` from the fixture folders evaluates it. */
export const registryFor = (selection?: string): Promise<typeof import('@shared/bundledPlugins')> =>
  evaluateFor(resolve(ROOT, 'src/shared/bundledPlugins.ts'), selection);
