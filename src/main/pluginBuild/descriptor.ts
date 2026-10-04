// An installed plugin build's descriptor (its shared side's default export), which plugin.json's id, name, version and
// description come from: evaluated from source against a ChattyPop checkout, or from the built node/shared.js
// against the host modules this process has published.
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runnerImport } from 'vite';
import type { PluginDescriptor } from '../../shared/bundledTypes';
import { HOST_MODULES_KEY } from '../../shared/installedPlugins';

/** A plugin folder's shared entry, which every plugin has. */
export const SHARED_ENTRY = 'shared/index.ts';
const ENTRY = 'virtual:installed-plugin-check';
/** The bundled-plugin registries the host's shared modules import; a descriptor never reads them. */
const REGISTRY_PREFIX = 'virtual:bundled-plugins/';

const posixPath = (p: string): string => p.replaceAll('\\', '/');

/**
 * Evaluates the descriptor from source with `repoRoot`'s SDK, checks it (checkBundled) against `anchorFolders`' catalog
 * and its own, skipping a same-id folder. Throws if the folder name isn't the id.
 */
export async function sourceDescriptor(pluginDir: string, repoRoot: string, anchorFolders: readonly string[]): Promise<PluginDescriptor> {
  const own = resolve(pluginDir, SHARED_ENTRY);
  const others = anchorFolders.map((dir) => resolve(dir, SHARED_ENTRY)).filter((f) => existsSync(f) && f !== own);
  const code = [
    `import plugin from ${JSON.stringify(posixPath(own))};`,
    ...others.map((f, i) => `import p${i} from ${JSON.stringify(posixPath(f))};`),
    `import { anchorCatalog, checkBundled } from ${JSON.stringify(posixPath(resolve(repoRoot, 'src/shared/bundledCheck.ts')))};`,
    `const others = [${others.map((_, i) => `p${i}`).join(', ')}].filter((p) => p.manifest.id !== plugin.manifest.id);`,
    'checkBundled([plugin], anchorCatalog([...others, plugin]));',
    'export default plugin;',
  ].join('\n');
  const { module } = await runnerImport<{ default: PluginDescriptor }>(ENTRY, {
    configFile: false,
    root: repoRoot,
    logLevel: 'silent',
    resolve: { alias: { '@shared': resolve(repoRoot, 'src/shared'), '@plugin-sdk': resolve(repoRoot, 'src/plugin-sdk') } },
    plugins: [{
      name: 'chattypop-installed-plugin-check',
      resolveId: (id) => (id === ENTRY || id.startsWith(REGISTRY_PREFIX) ? `\0${id}` : undefined),
      load: (id) => (id === `\0${ENTRY}` ? code : id.startsWith(`\0${REGISTRY_PREFIX}`) ? 'export default []; export const catalog = null;' : undefined),
    }],
  });
  const { id } = module.default.manifest;
  if (id !== basename(pluginDir)) throw new Error(`${pluginDir}: its descriptor's id is ${id}; a plugin's folder is named by its id.`);
  return module.default;
}

/**
 * Imports the built node/shared.js through the host modules this process published (the app's main process does at
 * start). The import stays in this process's module cache; the start loads the installed copy from its own path.
 */
export async function builtDescriptor(sharedJs: string): Promise<PluginDescriptor> {
  const hosts = (globalThis as Record<symbol, Record<string, unknown> | undefined>)[HOST_MODULES_KEY];
  if (!hosts?.['@plugin-sdk/shared']) throw new Error('Building without a ChattyPop checkout reads the descriptor through the host\'s @plugin-sdk/shared, which this process hasn\'t published.');
  const mod = (await import(/* @vite-ignore */ pathToFileURL(sharedJs).href)) as { default?: PluginDescriptor };
  if (!mod.default?.manifest) throw new Error(`${SHARED_ENTRY} must default-export its definePlugin descriptor.`);
  return mod.default;
}
