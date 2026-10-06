// Applies staged changes before app imports, then accepts/refuses plugins by id. Must not load the registry whose contents this step decides.
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

/** Publishes shared namespaces and build-extracted core/main export names for startup validation without loading registry-dependent modules. */
function nodeModules(): ProvidedModules {
  publishHostModules({ '@plugin-sdk/shared': sharedSdk });
  return { '@plugin-sdk/shared': sharedSdk, ...Object.fromEntries(Object.entries(hostExports).map(([id, names]) => [id, exportSet(names)])) };
}

/** Applies staging, then validates manifests and synchronous shared descriptors in id order against bundled/accepted plugins. Refusals affect only that plugin. */
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
