// Folder plugins: reading plugin.json and activating its entry module.
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { errorMessage } from '@shared/errors';
import {
  PLUGIN_API_MAJOR_CHANGES,
  PLUGIN_API_VERSION,
  PLUGIN_ID_PATTERN,
  PLUGIN_MANIFEST_FILE,
  type PluginApi,
  type PluginManifest,
  type PluginOrigin,
} from '@shared/plugins';
import { nestedTablesError, tableNamespacesNest } from '@shared/bundledTypes';
import { createPluginApi, emptyRegistrations, type HostDeps } from './api';
import { cleanup, unload, type Loaded } from './loaded';
import { reservePluginId } from './tableOwners';

interface PluginModule {
  activate(api: PluginApi): void | (() => void) | Promise<void | (() => void)>;
}

/** Why a folder plugin can't take an id, by where the plugin holding it comes from. */
const TAKEN_BY: Readonly<Record<PluginOrigin, (id: string) => string>> = {
  bundled: (id) => `ChattyPop already includes plugin ${id}`,
  installed: (id) => `An installed plugin already provides plugin ${id}`,
  folder: (id) => `Another folder already provides plugin ${id}`,
};

const major = (semver: string): number => Number(semver.split('.')[0]);
const minor = (semver: string): number => Number(semver.split('.')[1] ?? 0);
/** A manifest path must stay inside its plugin folder. */
export const insideFolder = (dir: string, rel: string): boolean => resolve(dir, rel).startsWith(resolve(dir) + sep);

function readManifest(dir: string): PluginManifest {
  const m = JSON.parse(readFileSync(join(dir, PLUGIN_MANIFEST_FILE), 'utf8')) as Partial<PluginManifest>;
  if (typeof m.id !== 'string' || !PLUGIN_ID_PATTERN.test(m.id)) throw new Error(`plugin.json: id must match ${PLUGIN_ID_PATTERN}`);
  if (typeof m.version !== 'string' || typeof m.apiVersion !== 'string' || typeof m.main !== 'string') {
    throw new Error('plugin.json: version, apiVersion and main are required');
  }
  // Same major, and no newer minor than the host: a minor adds API the plugin may call. An older major says what changed.
  const hostMajor = major(PLUGIN_API_VERSION);
  if (major(m.apiVersion) < hostMajor) {
    throw new Error(
      `written for plugin API ${m.apiVersion}; this ChattyPop provides ${PLUGIN_API_VERSION}, where ${PLUGIN_API_MAJOR_CHANGES}. Update it for API ${hostMajor} (docs/plugins.md).`,
    );
  }
  if (major(m.apiVersion) !== hostMajor || minor(m.apiVersion) > minor(PLUGIN_API_VERSION)) {
    throw new Error(`written for plugin API ${m.apiVersion}; this ChattyPop provides ${PLUGIN_API_VERSION}`);
  }
  return m as PluginManifest;
}

/** What loading a folder plugin reaches of its host. */
export interface FolderHost {
  plugins: Map<string, Loaded>;
  deps: HostDeps;
  guard(p: Loaded, fn: () => unknown): void;
}

/** Loads the plugin in folder `dir`, listing it in `host.plugins`; records a failure on its entry. */
export async function loadFolderPlugin(dir: string, disabled: Set<string>, generation: number, host: FolderHost): Promise<void> {
  let manifest: PluginManifest;
  try {
    manifest = readManifest(dir);
  } catch (err) {
    const id = dir.split(sep).pop()!;
    host.plugins.set(host.plugins.has(id) ? `${id}@${dir}` : id, { manifest: { id, version: '?', apiVersion: '?', main: '' }, dir, origin: 'folder', entry: null, status: 'error', error: errorMessage(err), reg: emptyRegistrations() });
    return;
  }
  const p: Loaded = { manifest, dir, origin: 'folder', entry: null, status: 'disabled', error: null, reg: emptyRegistrations() };
  const taken = host.plugins.get(manifest.id);
  if (taken) {
    p.status = 'error';
    p.error = TAKEN_BY[taken.origin](manifest.id);
    host.plugins.set(`${manifest.id}@${dir}`, p);
    return;
  }
  host.plugins.set(manifest.id, p);
  const nesting = [...host.plugins.values()].find((other) => tableNamespacesNest(manifest.id, other.manifest.id));
  if (nesting) {
    p.status = 'error';
    p.error = nestedTablesError(manifest.id, nesting.manifest.id).message;
    return;
  }
  if (disabled.has(manifest.id)) return;
  const entry = resolve(dir, manifest.main);
  if (!insideFolder(dir, manifest.main)) {
    p.status = 'error';
    p.error = 'main must be inside the plugin folder';
    return;
  }
  try {
    reservePluginId(host.deps.db, manifest.id);
  } catch (err) {
    p.status = 'error';
    p.error = errorMessage(err);
    return;
  }
  try {
    const mod = (await import(`${pathToFileURL(entry).href}?v=${generation}`)) as PluginModule;
    if (p.retired) return;
    if (typeof mod.activate !== 'function') throw new Error(`${manifest.main} does not export activate(api)`);
    const api = createPluginApi(manifest.id, host.deps, p.reg, (fn) => host.guard(p, fn));
    const deactivate = await mod.activate(api);
    // Unloaded while activating (switched off, reloaded, archive closing): what it returned runs now, never committed.
    if (p.retired) return void (typeof deactivate === 'function' && cleanup(p, 'deactivate', deactivate));
    if (typeof deactivate === 'function') p.deactivate = deactivate;
    p.status = 'active';
  } catch (err) {
    if (p.retired) return console.error(`[plugin ${manifest.id}] activation failed after it was unloaded`, err);
    unload(p);
    p.status = 'error';
    p.error = errorMessage(err);
  }
}
