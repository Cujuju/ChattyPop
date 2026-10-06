// Pure startup checks validate manifests before code loading, then descriptors against bundled and previously accepted plugins in id order.
import { anchorCatalog, checkBundled, type AnchorCatalog } from './bundledCheck';
import type { PluginDescriptor } from './bundledTypes';
import { SLOT_KINDS } from './slots';
import { HOST_MODULES, missingHostImports, sdkMismatch, type InstalledManifest, type Platform } from './installedPlugins';

/** Host modules by id as missingHostImports reads them: a namespace, or a set of export names (exportSet). */
export type ProvidedModules = Readonly<Record<string, object | undefined>>;

/** An accepted plugin whose module failed to load in some process: that process leaves the plugin out and shows why. */
export interface InstalledFailure {
  id: string;
  error: string;
}

/** `names` as missingHostImports reads a namespace: an own key per export and no prototype, so `toString` isn't one. */
export const exportSet = (names: readonly string[]): object =>
  Object.assign(Object.create(null) as object, Object.fromEntries(names.map((n) => [n, true])));

/** Rejects manifest folder/id mismatches, taken ids, incompatible SDK versions and missing host exports for the platform. */
export function checkManifest(folder: string, manifest: InstalledManifest, taken: ReadonlySet<string>, platform: Platform, provided: ProvidedModules): void {
  if (manifest.id !== folder) throw new Error(`plugin.json names ${manifest.id}, but its folder is ${folder}.`);
  if (taken.has(manifest.id)) throw new Error(`ChattyPop already includes plugin ${manifest.id}.`);
  const sdk = sdkMismatch(manifest.sdk);
  if (sdk) throw new Error(sdk);
  const missing = missingImportsFrom(manifest, HOST_MODULES[platform], provided);
  if (missing.length) throw new Error(`imports what this ChattyPop doesn't provide (${missing.join(', ')}). Update ChattyPop or the plugin.`);
}

/** The exports `manifest` imports from host modules `ids` that `provided` lacks (missingHostImports over those modules). */
export function missingImportsFrom(manifest: InstalledManifest, ids: readonly string[], provided: ProvidedModules): string[] {
  const own = new Set(ids);
  const imports = Object.fromEntries(Object.entries(manifest.hostImports).filter(([id]) => own.has(id)));
  return missingHostImports({ ...manifest, hostImports: imports }, provided);
}

/** A plugin's shared module's default export as plugin `id`'s descriptor; throws when it isn't one. */
export function descriptorOf(id: string, exported: unknown): PluginDescriptor {
  const manifest = typeof exported === 'object' && exported !== null ? (exported as { manifest?: { id?: unknown } }).manifest : undefined;
  if (typeof manifest?.id !== 'string') throw new Error('its shared module must export its descriptor (definePlugin) as default.');
  if (manifest.id !== id) throw new Error(`its descriptor is plugin ${manifest.id}, not ${id}.`);
  return exported as PluginDescriptor;
}

/** A dictionary with `b`'s entries over `a`'s; no prototype, so any id (`__proto__` too) is an own entry. */
const over = <T>(a: Record<string, T>, b: Record<string, T>): Record<string, T> => Object.assign(Object.create(null) as Record<string, T>, a, b);

/** Every anchorable item: the build's catalog (every plugin folder's, when `buildCatalog` is given) with `installed`'s. */
export function mergedCatalog(build: readonly PluginDescriptor[], buildCatalog: AnchorCatalog | null, installed: readonly PluginDescriptor[]): AnchorCatalog {
  const base = buildCatalog ?? anchorCatalog(build);
  const extra = anchorCatalog(installed);
  const slots = Object.fromEntries(SLOT_KINDS.map((kind) => [kind, over(base.slots[kind], extra.slots[kind])])) as AnchorCatalog['slots'];
  return {
    plugins: [...new Set([...base.plugins, ...extra.plugins])],
    panels: over(base.panels, extra.panels),
    tabs: over(base.tabs, extra.tabs),
    shortcuts: over(base.shortcuts, extra.shortcuts),
    slots,
    notices: over(base.notices, extra.notices),
    jevFeatures: over(base.jevFeatures, extra.jevFeatures),
    jevQueries: over(base.jevQueries, extra.jevQueries),
  };
}

/**
 * Keeps `candidates`, in order, whose descriptor validates (checkBundled) beside the build's and those kept; refuses
 * others with why. Anchors resolve against all candidates. Main's start decides; every process reruns it.
 */
export function acceptInstalled<T>(
  build: readonly PluginDescriptor[],
  buildCatalog: AnchorCatalog | null,
  candidates: readonly T[],
  descriptor: (candidate: T) => PluginDescriptor,
): { kept: T[]; refused: { candidate: T; error: unknown }[] } {
  const catalog = mergedCatalog(build, buildCatalog, candidates.map(descriptor));
  const kept: T[] = [];
  const refused: { candidate: T; error: unknown }[] = [];
  for (const candidate of candidates) {
    try {
      checkBundled([...build, ...kept.map(descriptor), descriptor(candidate)], catalog, 'absent');
      kept.push(candidate);
    } catch (error) {
      refused.push({ candidate, error });
    }
  }
  return { kept, refused };
}
