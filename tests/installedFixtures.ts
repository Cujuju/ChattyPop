// Hand-written built plugins (docs/plugin-architecture.md §16) for the installed-plugin tests: plugin.json and ES modules
// that read the host's SDK from globalThis, as a plugin build's shims do. Imports nothing that loads the plugin registry.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inject } from 'vitest';
import { HOST_MODULES_KEY, INSTALLED_FORMAT, INSTALLED_PLUGINS_DIR, PLUGIN_SDK_VERSION } from '@shared/installedPlugins';

/** A fresh profile's installed-plugins folder, inside this run's temp folder (tests/globalSetup.ts). */
export const installedRoot = (): string => join(mkdtempSync(join(inject('tempRoot'), 'profile-')), INSTALLED_PLUGINS_DIR);

/** Source reading host module `id` from the published namespaces, as a build's shim does. */
export const host = (id: string): string => `globalThis[Symbol.for(${JSON.stringify(HOST_MODULES_KEY.description)})][${JSON.stringify(id)}]`;

/** A node shared module exporting plugin `id`'s descriptor; `more` is extra descriptor source (`channels: …`). */
export const sharedModule = (id: string, more = ''): string =>
  `const { definePlugin, defineChannels } = ${host('@plugin-sdk/shared')};\n` +
  `export default definePlugin({ manifest: { id: ${JSON.stringify(id)}, name: 'Plugin ${id}', version: '1.0.0', description: '' }${more ? `, ${more}` : ''} });\n`;

export interface FixtureOptions {
  /** plugin.json fields over the defaults. */
  manifest?: Record<string, unknown>;
  /** node/shared.js source; a descriptor of the folder's id by default. */
  shared?: string;
  core?: string;
  main?: string;
}

/** Writes a built plugin folder `folder` under `root` (an installed-plugins folder, or its .staged); returns its path. */
export function writePlugin(root: string, folder: string, o: FixtureOptions = {}): string {
  const dir = join(root, folder);
  const files: Record<string, string> = { 'node/shared.js': o.shared ?? sharedModule(folder), 'browser/shared.js': 'export default null;\n' };
  if (o.core !== undefined) files['node/core.js'] = o.core;
  if (o.main !== undefined) files['node/main.js'] = o.main;
  const manifest = {
    format: INSTALLED_FORMAT,
    id: folder,
    name: `Plugin ${folder}`,
    version: '1.0.0',
    description: '',
    sdk: PLUGIN_SDK_VERSION,
    node: { shared: 'node/shared.js', ...(o.core !== undefined ? { core: 'node/core.js' } : {}), ...(o.main !== undefined ? { main: 'node/main.js' } : {}) },
    browser: { shared: 'browser/shared.js', styles: [] },
    hostImports: { '@plugin-sdk/shared': ['definePlugin', 'defineChannels'] },
    ...o.manifest,
  };
  files['plugin.json'] = JSON.stringify(manifest);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}
