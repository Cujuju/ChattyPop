// First-start restore (docs/plugin-architecture.md §16): plugins whose data the profile holds but that aren't installed,
// matched against marketplace listings so they can be installed again.
import { TABLE_NAME } from './bundledTypes';
import { sdkMismatch } from './installedPlugins';
import {
  PUBLIC_MARKETPLACE,
  type InstallChoice,
  type InstalledEntry,
  type MarketplaceListing,
  type MarketplacePlugin,
  type MarketplaceRelease,
  type PluginHistory,
} from './marketplace';
import { stringsOr } from './normalize';
import { PLUGIN_ID_PATTERN } from './plugins';

/** Where a plugin's data was found: its tables, preferences, data folder, rule parts, or its on/off state. */
export type FootprintKind = 'table' | 'preference' | 'dataDir' | 'rule' | 'state';

/** Data of a plugin this ChattyPop doesn't load (not bundled, installed or in the plugins folder). */
export interface AbsentPlugin {
  /** Its id; for tables alone, every id their names can belong to (`p_a_b_c`: a, a-b), shortest first. */
  ids: string[];
  kinds: FootprintKind[];
}

/** The plugins the app bundled until they moved to marketplaces, by repo; profiles from then have no install history. */
const MOVED_PLUGINS: Readonly<Record<string, readonly string[]>> = {
  [PUBLIC_MARKETPLACE]: ['alerts', 'claude', 'codex', 'exchange', 'imagetext', 'links', 'ollama', 'openrouter', 'plans', 'rerank', 'stats', 'summaries', 'tags', 'transcription', 'usage'],
};
const movedTo = new Map(Object.entries(MOVED_PLUGINS).flatMap(([repo, ids]) => ids.map((id) => [id, repo] as const)));

/** The marketplace plugin `id` came from: its install history's, else the one it moved to from the app; null when unknown. */
export const originRepo = (id: string, history: PluginHistory): string | null => history[id]?.repo ?? movedTo.get(id) ?? null;

/** A table name's prefix before the plugin id (pluginTableName). */
const TABLE_PREFIX = 'p_';

/**
 * Every plugin id table `name` can belong to, shortest first. A table is `p_<id, dashes as underscores>_<name>` and
 * both parts may hold underscores, so the id's end is ambiguous.
 */
export function tableIds(name: string): string[] {
  if (!name.startsWith(TABLE_PREFIX)) return [];
  const parts = name.slice(TABLE_PREFIX.length).split('_');
  const ids: string[] = [];
  for (let end = 1; end < parts.length; end++) {
    const id = parts.slice(0, end).join('-');
    if (PLUGIN_ID_PATTERN.test(id) && TABLE_NAME.test(parts.slice(end).join('_'))) ids.push(id);
  }
  return ids;
}

/** The newest release this ChattyPop can run, or null. Releases are newest first (parseMarketplaceIndex). */
export const newestCompatible = (plugin: MarketplacePlugin): MarketplaceRelease | null => plugin.releases.find((r) => sdkMismatch(r.sdk) === null) ?? null;

/** What a marketplace listing offers to restore a plugin: its newest compatible release, else its source. */
export interface RestoreInstall {
  repo: string;
  choice: InstallChoice;
  /** The release's version; null for a source install. */
  version: string | null;
}

/** An absent plugin as Settings → Plugins offers it. */
export interface RestoreItem {
  id: string;
  /** Its listed name; its id (or ids) when no marketplace lists it. */
  name: string;
  kinds: FootprintKind[];
  /** Null when it can't be installed here; `problem` says why. */
  install: RestoreInstall | null;
  problem: string | null;
  /** The marketplace it came from when that isn't added (`added` false) or couldn't be read: adding it, or a token, may list it. */
  needs: { repo: string; added: boolean } | null;
}

/** The setting holding which plugins the owner dismissed and which the start prompt already showed. */
export const PLUGIN_RESTORE_KEY = 'plugins.restore';

export interface PluginRestoreSettings {
  /** Never offered again. */
  dismissed: string[];
  /** Shown by the start prompt once; Settings → Plugins still offers them. */
  prompted: string[];
}

const ids = stringsOr<string[]>([]);
export const normalizePluginRestore = (v: unknown): PluginRestoreSettings => {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  return { dismissed: ids(o['dismissed']), prompted: ids(o['prompted']) };
};

function installOf(repo: string, plugin: MarketplacePlugin): RestoreInstall | null {
  const release = newestCompatible(plugin);
  if (release) return { repo, choice: { kind: 'release', version: release.version }, version: release.version };
  return plugin.source ? { repo, choice: { kind: 'source' }, version: null } : null;
}

/** Why `plugin` can't be installed here: its newest release's SDK, or nothing to install. */
function cannotInstall(plugin: MarketplacePlugin): string {
  const newest = plugin.releases[0];
  return newest ? `Its releases can't run here: ${sdkMismatch(newest.sdk) ?? 'none is compatible'}.` : 'Its marketplace lists no release or source.';
}

const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** `id` in the listings: its origin marketplace's alone when known (originRepo), so another repo's same id never stands in. */
const listingsOf = (id: string, marketplaces: readonly MarketplaceListing[], history: PluginHistory): { repo: string; plugin: MarketplacePlugin }[] => {
  const origin = originRepo(id, history);
  return marketplaces
    .filter((m) => origin === null || sameRepo(m.repo, origin))
    .flatMap((m) => m.plugins.filter((p) => p.id === id).map((plugin) => ({ repo: m.repo, plugin })));
};

/**
 * Why an unlisted plugin can't be found: the marketplace it came from (originRepo), when known, isn't added or couldn't
 * be read. A token can't help a built-in one.
 */
function notFound(ids: readonly string[], marketplaces: readonly MarketplaceListing[], history: PluginHistory): Pick<RestoreItem, 'problem' | 'needs'> {
  const repo = ids.map((id) => originRepo(id, history)).find((r) => r !== null);
  if (!repo) return { problem: 'Not found in your marketplaces.', needs: null };
  const listing = marketplaces.find((m) => sameRepo(m.repo, repo));
  if (!listing) return { problem: `Needs marketplace ${repo}.`, needs: { repo, added: false } };
  if (listing.error) return { problem: `Needs marketplace ${repo}, which couldn't be read: ${listing.error}`, needs: listing.builtIn ? null : { repo, added: true } };
  return { problem: `Not found in marketplace ${repo}.`, needs: null };
}

/**
 * Absent plugins to offer: each matched to first marketplace listing it (installable first; only its origin's when
 * known), candidate ids longest first. Omits dismissed, owner-uninstalled, installed or staged ones.
 */
export function restoreItems(
  absent: readonly AbsentPlugin[],
  marketplaces: readonly MarketplaceListing[],
  installed: readonly InstalledEntry[],
  history: PluginHistory,
  dismissed: readonly string[],
): RestoreItem[] {
  const skip = new Set([...dismissed, ...installed.map((e) => e.id), ...Object.keys(history).filter((id) => history[id]!.uninstalled)]);
  const items: RestoreItem[] = [];
  for (const entry of absent) {
    if (entry.ids.some((id) => skip.has(id))) continue;
    const listed = [...entry.ids].reverse().flatMap((id) => listingsOf(id, marketplaces, history));
    const match = listed.find((l) => installOf(l.repo, l.plugin)) ?? listed[0];
    if (match) {
      const install = installOf(match.repo, match.plugin);
      items.push({ id: match.plugin.id, name: match.plugin.name, kinds: entry.kinds, install, problem: install ? null : cannotInstall(match.plugin), needs: null });
    } else {
      items.push({ id: entry.ids[0]!, name: entry.ids.join(' or '), kinds: entry.kinds, install: null, ...notFound(entry.ids, marketplaces, history) });
    }
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}
