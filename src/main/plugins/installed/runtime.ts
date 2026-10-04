// Installed plugins in main and core (docs/plugin-architecture.md §16): the start main decided, as INSTALLED_ENV carries
// it, and each accepted plugin's node modules, loaded synchronously once the host modules they read are published.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { AnchorCatalog } from '@shared/bundledCheck';
import type { PluginDescriptor } from '@shared/bundledTypes';
import { errorMessage } from '@shared/errors';
import { publishHostModules } from '@shared/hostModules';
import { acceptInstalled, descriptorOf, type InstalledFailure } from '@shared/installedCheck';
import { INSTALLED_ENV, type HostModuleId, type InstalledPlugin, type InstalledStart, type RefusedPlugin } from '@shared/installedPlugins';
import { readInstalledPlugin } from './read';

/** `require` of an ES module: synchronous, and sharing the module cache with `import`, so a file loads once per process. */
const requireModule = createRequire(import.meta.url);

type NodeSide = keyof InstalledPlugin['manifest']['node'];

/** The default export of `plugin`'s node module for `side`, loaded synchronously (its first load runs it). */
export function loadNodeEntry(plugin: InstalledPlugin, side: NodeSide): unknown {
  const file = plugin.manifest.node[side];
  if (!file) throw new Error(`${plugin.manifest.id} has no node ${side} module.`);
  return (requireModule(join(plugin.dir, file)) as { default?: unknown }).default;
}

/**
 * INSTALLED_ENV's value: the installed-plugins folder, accepted ids and refusals. Manifests stay on disk (unchanged while
 * the app runs: installs are staged), so the value stays far below Windows' limit on one environment variable.
 */
interface StartWire {
  root: string;
  accepted: string[];
  refused: RefusedPlugin[];
}

/** `start` (plugins under `root`) as INSTALLED_ENV carries it. */
export const encodeInstalledStart = (root: string, start: InstalledStart): string =>
  JSON.stringify({ root, accepted: start.accepted.map((p) => p.manifest.id), refused: start.refused } satisfies StartWire);

let decoded: { raw: string; start: InstalledStart } | null = null;

/** What main's start decided (INSTALLED_ENV, which main sets before its app loads and core inherits); none when unset. */
export function installedStart(): InstalledStart {
  const raw = process.env[INSTALLED_ENV];
  if (!raw) return { accepted: [], refused: [] };
  if (decoded?.raw !== raw) {
    const wire = JSON.parse(raw) as StartWire;
    decoded = { raw, start: { accepted: wire.accepted.map((id) => readInstalledPlugin(join(wire.root, id))), refused: wire.refused } };
  }
  return decoded.start;
}

/** Accepted plugins whose descriptor failed to load in this process, by id: their other sides stay out too. */
const failedDescriptors = new Map<string, string>();

/**
 * The accepted plugins' descriptors (node shared modules), in id order, after publishing `modules`. One that throws is
 * left out, and so is one that no longer validates beside the build's (`build`, `catalog`) and the rest (acceptInstalled).
 */
export function installedDescriptors(modules: Partial<Record<HostModuleId, object>>, build: readonly PluginDescriptor[], catalog: AnchorCatalog | null): PluginDescriptor[] {
  publishHostModules(modules);
  const loaded = installedStart().accepted.flatMap((p) => {
    try {
      return [{ id: p.manifest.id, descriptor: descriptorOf(p.manifest.id, loadNodeEntry(p, 'shared')) }];
    } catch (err) {
      failedDescriptors.set(p.manifest.id, errorMessage(err));
      return [];
    }
  });
  const { kept, refused } = acceptInstalled(build, catalog, loaded, (l) => l.descriptor);
  for (const { candidate, error } of refused) failedDescriptors.set(candidate.id, errorMessage(error));
  return kept.map((l) => l.descriptor);
}

/** Whether `entry` is a core or main side (defineCorePlugin, defineMainPlugin) of plugin `id`. */
const isSideOf = (entry: unknown, id: string): boolean =>
  typeof entry === 'object' && entry !== null && typeof (entry as { activate?: unknown }).activate === 'function' &&
  (entry as { plugin?: { manifest?: { id?: unknown } } }).plugin?.manifest?.id === id;

/**
 * The accepted plugins' `side` modules' default exports, in id order, after publishing `modules`. One that throws or isn't
 * its plugin's side is left out and listed in `failed`, as is every plugin whose descriptor failed here.
 */
export function installedSides<T>(side: 'core' | 'main', modules: Partial<Record<HostModuleId, object>>): { entries: T[]; failed: InstalledFailure[] } {
  publishHostModules(modules);
  const entries: T[] = [];
  const failed: InstalledFailure[] = [];
  for (const p of installedStart().accepted) {
    const id = p.manifest.id;
    const descriptorError = failedDescriptors.get(id);
    if (descriptorError !== undefined) {
      failed.push({ id, error: descriptorError });
      continue;
    }
    if (!p.manifest.node[side]) continue;
    try {
      const entry = loadNodeEntry(p, side);
      if (!isSideOf(entry, id)) throw new Error(`its node ${side} module must export plugin ${id}'s ${side} side as default.`);
      entries.push(entry as T);
    } catch (err) {
      failed.push({ id, error: errorMessage(err) });
    }
  }
  return { entries, failed };
}
