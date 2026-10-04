// Installed plugins at main's start (docs/plugin-architecture.md §16): staged changes applied, then each plugin accepted
// or refused in id order. Main's boot entry runs it before the app, so nothing here may load the plugin registry
// (@shared/bundledPlugins), which lists what this decides (tests/installedPlugins.test.ts).
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as sharedSdk from '@plugin-sdk/shared';
import build, { catalog } from 'virtual:bundled-plugins/shared';
import hostExports from 'virtual:installed-plugins/host-exports';
import type { PluginDescriptor } from '@shared/bundledTypes';
import { errorMessage } from '@shared/errors';
import { publishHostModules } from '@shared/hostModules';
import { acceptInstalled, checkManifest, descriptorOf, exportSet, type ProvidedModules } from '@shared/installedCheck';
import type { InstalledManifest, InstalledPlugin, InstalledStart, RefusedPlugin } from '@shared/installedPlugins';
import { readInstalledPlugin } from './read';
import { loadNodeEntry } from './runtime';
import { applyStaged } from './staged';

/** Where the start reports what it couldn't apply or refused (main's diag). */
export type BootLog = (event: string, detail: Record<string, unknown>) => void;


/** Installed plugin folders under `root`, in id order; dot folders are the installer's (.staged, .held, .removed, .trash, .incoming). */
const pluginFolders = (root: string): string[] =>
  existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort() : [];

/**
 * The host modules a node side may import, as the start checks them: the shared tier's namespace, which it publishes;
 * core's and main's export names, read from their source by the build, since their modules load the plugin registry.
 */
function nodeModules(): ProvidedModules {
  publishHostModules({ '@plugin-sdk/shared': sharedSdk });
  return { '@plugin-sdk/shared': sharedSdk, ...Object.fromEntries(Object.entries(hostExports).map(([id, names]) => [id, exportSet(names)])) };
}

/**
 * Applies staged changes under `root` (the profile's installed-plugins folder), then decides this start's installed
 * plugins in id order: its manifest first (checkManifest), then its node shared module, loaded synchronously, and its
 * descriptor beside the build's and those accepted before it (acceptInstalled). A refusal or throw refuses that plugin alone.
 */
export function prepareInstalled(root: string, log: BootLog): InstalledStart {
  applyStaged(root, (id, err) => log('installed-plugin-staging-failed', { pluginId: id, message: errorMessage(err) }));
  const provided = nodeModules();
  const taken = new Set(build.map((p) => p.manifest.id));
  const loaded: { plugin: InstalledPlugin; descriptor: PluginDescriptor }[] = [];
  const refused: RefusedPlugin[] = [];
  const refuse = (id: string, manifest: InstalledManifest | null, err: unknown): void => {
    const error = errorMessage(err);
    refused.push({ id, name: manifest?.name ?? id, version: manifest?.version ?? '?', error });
    log('installed-plugin-refused', { pluginId: id, message: error });
  };
  for (const id of pluginFolders(root)) {
    let manifest: InstalledManifest | null = null;
    try {
      const plugin = readInstalledPlugin(join(root, id));
      manifest = plugin.manifest;
      checkManifest(id, manifest, taken, 'node', provided);
      loaded.push({ plugin, descriptor: descriptorOf(id, loadNodeEntry(plugin, 'shared')) });
    } catch (err) {
      refuse(id, manifest, err);
    }
  }
  const { kept, refused: unanchored } = acceptInstalled(build, catalog, loaded, (l) => l.descriptor);
  for (const { candidate, error } of unanchored) refuse(candidate.plugin.manifest.id, candidate.plugin.manifest, error);
  return { accepted: kept.map((l) => l.plugin), refused: refused.sort((a, b) => a.id.localeCompare(b.id)) };
}
