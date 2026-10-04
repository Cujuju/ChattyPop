// Plugin marketplaces (docs/plugin-architecture.md §16): GitHub repos the owner adds by hand, each listing plugins in
// marketplace.json on its default branch. Main fetches, verifies and stages installs; they apply at the next start.
import { PLUGIN_ID_PATTERN } from './plugins';
import { SHA256_PATTERN, VERSION_PATTERN, compareVersions, type InstalledSource } from './installedPlugins';

/** The index file at a marketplace repo's root, on its default branch. */
export const MARKETPLACE_INDEX_FILE = 'marketplace.json';
/** The index format this host reads. */
export const MARKETPLACE_FORMAT = 1;
/** Where a marketplace repo keeps each plugin, as `plugins/<id>`: what a source install builds unless the index names another folder. */
export const MARKETPLACE_PLUGINS_DIR = 'plugins';
/** A path inside the repo: relative, forward slashes, no `.` or `..` parts. */
const REPO_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._\-/]+$/;

/** A prebuilt version: a release asset (a .tar.gz of the built plugin folder). */
export interface MarketplaceRelease {
  version: string;
  /** The GitHub release's tag. */
  tag: string;
  /** The asset's file name in that release. */
  asset: string;
  /** Lowercase hex sha256 of the asset; the download must match it. */
  sha256: string;
  /** PLUGIN_SDK_VERSION it was built against. */
  sdk: string;
}

export interface MarketplacePlugin {
  id: string;
  name: string;
  description: string;
  /** Prebuilt versions, each once, newest first (parseMarketplaceIndex sorts them). */
  releases: MarketplaceRelease[];
  /**
   * Its source in this repo, for installs that build from source: the plugin folder and the branch they follow. Read from
   * GitHub, every plugin has one: the index's, else its MARKETPLACE_PLUGINS_DIR folder on the repo's default branch.
   */
  source?: { path: string; branch: string };
}

export interface MarketplaceIndex {
  format: typeof MARKETPLACE_FORMAT;
  plugins: MarketplacePlugin[];
}

const fail = (what: string): never => {
  throw new Error(`${MARKETPLACE_INDEX_FILE}: ${what}`);
};
const str = (o: Record<string, unknown>, key: string, where: string, pattern?: RegExp): string => {
  const v = o[key];
  if (typeof v !== 'string' || !v || (pattern && !pattern.test(v))) fail(`${where}.${key} is missing or malformed`);
  return v as string;
};
const obj = (v: unknown, where: string): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : fail(`${where} must be an object`);

/**
 * marketplace.json as this host reads it; throws the reason it is refused. With defaultBranch (the repo's, as the app
 * reads it), a plugin the index gives no `source` builds from its MARKETPLACE_PLUGINS_DIR folder on that branch.
 */
export function parseMarketplaceIndex(raw: unknown, defaultBranch?: string): MarketplaceIndex {
  const index = obj(raw, 'the index');
  if (index['format'] !== MARKETPLACE_FORMAT) fail(`format ${String(index['format'])} is not ${MARKETPLACE_FORMAT}, the one this ChattyPop reads`);
  if (!Array.isArray(index['plugins'])) fail('plugins must be a list');
  const seen = new Set<string>();
  const plugins = (index['plugins'] as unknown[]).map((rawPlugin, i): MarketplacePlugin => {
    const where = `plugins[${i}]`;
    const p = obj(rawPlugin, where);
    const id = str(p, 'id', where, PLUGIN_ID_PATTERN);
    if (seen.has(id)) fail(`plugin ${id} is listed twice`);
    seen.add(id);
    if (!Array.isArray(p['releases'])) fail(`${where}.releases must be a list`);
    const versions = new Set<string>();
    const releases = (p['releases'] as unknown[]).map((rawRelease, j): MarketplaceRelease => {
      const at = `${where}.releases[${j}]`;
      const r = obj(rawRelease, at);
      const version = str(r, 'version', at, VERSION_PATTERN);
      if (versions.has(version)) fail(`plugin ${id} lists version ${version} twice`);
      versions.add(version);
      return { version, tag: str(r, 'tag', at), asset: str(r, 'asset', at), sha256: str(r, 'sha256', at, SHA256_PATTERN), sdk: str(r, 'sdk', at, VERSION_PATTERN) };
    });
    // Newest first, whatever order the file lists them in.
    releases.sort((a, b) => compareVersions(b.version, a.version));
    const source = p['source'] === undefined ? undefined : obj(p['source'], `${where}.source`);
    return {
      id,
      name: str(p, 'name', where),
      description: typeof p['description'] === 'string' ? p['description'] : '',
      releases,
      ...(source
        ? { source: { path: str(source, 'path', `${where}.source`, REPO_PATH), branch: str(source, 'branch', `${where}.source`) } }
        : defaultBranch ? { source: { path: `${MARKETPLACE_PLUGINS_DIR}/${id}`, branch: defaultBranch } } : {}),
    };
  });
  return { format: MARKETPLACE_FORMAT, plugins };
}

/** The public plugins' marketplace, where the app's public plugins moved. */
export const PUBLIC_MARKETPLACE = 'Cujuju/ChattyPop-Plugins-Public';

/** Marketplaces every profile lists without adding them: public, so they need no token, and they can't be removed. */
export const BUILT_IN_MARKETPLACES: readonly string[] = [PUBLIC_MARKETPLACE];

/** A marketplace the owner added, or a built-in one. */
export interface Marketplace {
  repo: string;
  /** Whether a token is stored for it (a private repo); the token itself never leaves main. */
  hasToken: boolean;
  /** Listed in every profile (BUILT_IN_MARKETPLACES): no token, no removal. */
  builtIn: boolean;
}

/** A marketplace as last fetched: its plugins, or why it couldn't be read. */
export interface MarketplaceListing extends Marketplace {
  plugins: MarketplacePlugin[];
  error: string | null;
  fetchedAt: number | null;
}

/** What to install from a marketplace plugin: a prebuilt version, or its source at the branch's latest commit. */
export type InstallChoice = { kind: 'release'; version: string } | { kind: 'source' };

/** An installed plugin as the marketplace view shows it: what runs now, and what the next start changes. */
export interface InstalledEntry {
  id: string;
  name: string;
  /** The version running now; null when it isn't installed yet (only staged). */
  version: string | null;
  source: InstalledSource | null;
  /** What the next start does to it. */
  pending: { kind: 'install'; version: string; source: InstalledSource } | { kind: 'remove' } | null;
}

/**
 * Each plugin id's last marketplace action: the repo it was installed from (null for a local build), and whether
 * removal was asked since. First-start restore reads it (pluginRestore.ts).
 */
export type PluginHistory = Record<string, { repo: string | null; uninstalled: boolean }>;

/** Main's marketplace state as windows read it. */
export interface MarketplaceState {
  marketplaces: MarketplaceListing[];
  installed: InstalledEntry[];
  history: PluginHistory;
}

/** Settings → Plugins → Marketplaces (RendererApi.marketplace). Every change applies at the next start. */
export interface MarketplaceApi {
  /** The built-in and added marketplaces as last fetched, the installed plugins, and the install history. */
  state(): Promise<MarketplaceState>;
  /** Adds `owner/name`, with a fine-grained read-only token for a private repo; rejects when its index can't be read. */
  add(repo: string, token: string | null): Promise<void>;
  /** Forgets a marketplace and its token; installed plugins stay. A built-in one is refused. */
  remove(repo: string): Promise<void>;
  /** Replaces or clears a marketplace's token; a built-in one needs none and is refused. */
  setToken(repo: string, token: string | null): Promise<void>;
  /** Fetches every marketplace's index again. */
  refresh(): Promise<void>;
  /** Downloads, verifies and stages a plugin; it installs or updates at the next start. */
  install(repo: string, pluginId: string, choice: InstallChoice): Promise<void>;
  /** Stages a built plugin folder or .tar.gz on this PC (development). */
  installLocal(path: string): Promise<void>;
  /** The plugin is gone after the next start: drops a staged install or update, and removes an installed one. Its data stays. */
  uninstall(pluginId: string): Promise<void>;
  /** Drops a plugin's pending change (staged install or update, or removal): the next start leaves it as it runs now. */
  cancel(pluginId: string): Promise<void>;
}
