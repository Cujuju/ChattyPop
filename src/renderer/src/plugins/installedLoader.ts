// Loads installed shared/renderers/styles with injected host modules. Failed plugins are reported/excluded while windows continue; only registry wiring imports this module.
import type { AnchorCatalog } from '@shared/bundledCheck';
import type { PluginDescriptor } from '@shared/bundledTypes';
import { hostModules, publishHostModules } from '@shared/hostModules';
import { INSTALLED_INDEX, INSTALLED_PHONE_PATH, INSTALLED_SCHEME } from '@shared/installedBrowser';
import { acceptInstalled, missingImportsFrom } from '@shared/installedCheck';
import { HOST_MODULES, parseInstalledManifest, type HostModuleId, type InstalledManifest, type TierHostModules } from '@shared/installedPlugins';
import { checkSlotViews, type SlotViewsOf } from '@shared/slots';
import { windowAudience } from '@/api';
import type { RendererPlugin } from './define';

/** How the loader reaches the installed plugins; tests pass stand-ins. */
export interface LoaderIo {
  /** The index: the accepted plugins' manifests, in load order. */
  index(): Promise<unknown>;
  /** The URL of `file` in plugin `id`'s browser folder. */
  url(id: string, file: string): string;
  /** An ES module's namespace. */
  load(url: string): Promise<Record<string, unknown>>;
  /** Adds a stylesheet after the page's own; resolves once it applies with a function removing it, rejects when it fails. */
  stylesheet(url: string): Promise<() => void>;
  /** A plugin (or the index, as null) that couldn't load. */
  report(id: string | null, error: unknown): void;
}

/** A plugin whose shared side loaded: its manifest and descriptor. */
export interface SharedLoaded {
  manifest: InstalledManifest;
  descriptor: PluginDescriptor;
}


/** Throws naming the exports of `ids` that `manifest` imports and the published host modules lack. */
function requireHostImports(manifest: InstalledManifest, ids: readonly HostModuleId[]): void {
  const missing = missingImportsFrom(manifest, ids, hostModules());
  if (missing.length) throw new Error(`it imports what this ChattyPop's windows don't provide: ${missing.join(', ')}`);
}

/** The module's default export, which `idOf` must find to be plugin `id`'s. */
function ownDefault<T>(mod: Record<string, unknown>, id: string, idOf: (v: T) => unknown, what: string): T {
  const value = mod['default'] as T | null | undefined;
  if (typeof value !== 'object' || value === null || idOf(value) !== id) throw new Error(`its ${what} doesn't export plugin ${id}`);
  return value;
}

/** The index's manifests; none when it can't be read (reported). */
async function manifests(io: LoaderIo): Promise<InstalledManifest[]> {
  let raw: unknown;
  try {
    raw = await io.index();
    if (!Array.isArray(raw)) throw new Error('the installed-plugin index is not a list');
  } catch (err) {
    io.report(null, err);
    return [];
  }
  return raw.flatMap((m: unknown) => {
    try {
      return [parseInstalledManifest(m)];
    } catch (err) {
      const id = (m as { id?: unknown } | null)?.id;
      io.report(typeof id === 'string' ? id : null, err);
      return [];
    }
  });
}

/** Publishes shared SDK, imports accepted descriptors in order, then validates against bundled/accepted catalog. Plugins anchored to failed entries are excluded. */
export async function loadShared(io: LoaderIo, sdkShared: object, build: readonly PluginDescriptor[], catalog: AnchorCatalog | null): Promise<SharedLoaded[]> {
  publishHostModules({ '@plugin-sdk/shared': sdkShared });
  const loaded: SharedLoaded[] = [];
  for (const manifest of await manifests(io)) {
    try {
      requireHostImports(manifest, ['@plugin-sdk/shared']);
      const mod = await io.load(io.url(manifest.id, manifest.browser.shared));
      loaded.push({ manifest, descriptor: ownDefault<PluginDescriptor>(mod, manifest.id, (d) => d.manifest?.id, 'shared.js') });
    } catch (err) {
      io.report(manifest.id, err);
    }
  }
  const { kept, refused } = acceptInstalled(build, catalog, loaded, (l) => l.descriptor);
  for (const { candidate, error } of refused) io.report(candidate.manifest.id, error);
  return kept;
}

/** Adds `manifest`'s stylesheets, in its order, once all apply; removes those that did when one fails. */
async function addStylesheets(io: LoaderIo, manifest: InstalledManifest): Promise<() => void> {
  const added = await Promise.allSettled(manifest.browser.styles.map((file) => io.stylesheet(io.url(manifest.id, file))));
  const removeAll = (): void => added.forEach((r) => r.status === 'fulfilled' && r.value());
  const failed = added.find((r) => r.status === 'rejected');
  if (failed) {
    removeAll();
    throw failed.reason;
  }
  return removeAll;
}

/** Publishes renderer tiers/Solid, awaits styles, then imports renderer entries. Returned views exactly match declared slot items; renderer-less plugins cannot declare items. */
export async function loadRenderers(io: LoaderIo, shared: readonly SharedLoaded[], modules: TierHostModules<'browser'>): Promise<RendererPlugin[]> {
  publishHostModules(modules);
  const entries: RendererPlugin[] = [];
  for (const { manifest, descriptor } of shared) {
    let removeStyles = (): void => undefined;
    try {
      requireHostImports(manifest, HOST_MODULES.browser);
      removeStyles = await addStylesheets(io, manifest);
      if (!manifest.browser.renderer) {
        checkSlotViews(manifest.id, descriptor.slots, {});
        continue;
      }
      const mod = await io.load(io.url(manifest.id, manifest.browser.renderer));
      const entry = ownDefault<RendererPlugin>(mod, manifest.id, (e) => e.plugin?.manifest?.id, 'renderer.js');
      checkSlotViews(manifest.id, entry.plugin.slots, entry.contributions as SlotViewsOf);
      entries.push(entry);
    } catch (err) {
      removeStyles();
      io.report(manifest.id, err);
    }
  }
  return entries;
}

/** This window's base: the scheme in the desktop's windows (the preload's), the Companion's path on the phone page. */
const base = (): string => (windowAudience() === 'renderer' ? `${INSTALLED_SCHEME}://` : INSTALLED_PHONE_PATH);

/** The window's own IO: fetch and import from main (desktop) or the Companion's server (phone), link elements, the console. */
export function windowIo(): LoaderIo {
  return {
    async index() {
      const r = await fetch(`${base()}${INSTALLED_INDEX}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`the installed-plugin index answered ${r.status}`);
      return r.json();
    },
    url: (id, file) => `${base()}${id}/${file}`,
    load: (url) => import(/* @vite-ignore */ url) as Promise<Record<string, unknown>>,
    stylesheet: (url) =>
      new Promise((resolve, reject) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = url;
        link.onload = () => resolve(() => link.remove());
        link.onerror = () => {
          link.remove();
          reject(new Error(`its stylesheet ${url} didn't load`));
        };
        document.head.append(link);
      }),
    report: (id, error) => console.error(id ? `Installed plugin ${id} was left out of this window:` : 'Installed plugins were left out of this window:', error),
  };
}
