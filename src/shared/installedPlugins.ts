// Pure installed-output contract covers profile-loaded descriptors from releases, source builds and local folders. Shared by loaders and tooling.
import { INSTALLED_CONTENT_TYPES, INSTALLED_PHONE_PATH } from './installedBrowser';
import { PLUGIN_ID_PATTERN } from './plugins';

/**
 * Descriptor SDK version. Major: a change breaking built plugins (removed or changed export or context member); minor:
 * additions. tests/sdkSurface.test.ts holds exports to it; context members are on review.
 */
export const PLUGIN_SDK_VERSION = '2.34.0';
/** The built-output format this host reads (plugin.json `format`). */
export const INSTALLED_FORMAT = 1;

/** Profile folder of installed plugins, one folder per plugin id. Folder plugins (PluginApi) keep `plugins`. */
export const INSTALLED_PLUGINS_DIR = 'installed-plugins';
/** Inside it: complete, checked builds that replace `<id>` at the next start (install or update). */
export const STAGED_DIR = '.staged';
/** Inside it: an empty file per plugin id to remove at the next start. */
export const REMOVED_DIR = '.removed';
/** Inside it: folders being replaced, deleted once the swap is done. */
export const TRASH_DIR = '.trash';
/** Inside it: a staged copy a newer one is replacing. The next start puts it back when the swap never finished. */
export const HELD_DIR = '.held';
export const INSTALLED_MANIFEST_FILE = 'plugin.json';
/** Beside plugin.json: where the install came from (InstalledSource). Absent for a build nobody installed. */
export const INSTALLED_SOURCE_FILE = 'source.json';

/** Environment variable main sets for itself and core: the start's InstalledStart (encodeInstalledStart in main). */
export const INSTALLED_ENV = 'CHATTYPOP_INSTALLED_PLUGINS';
/** globalThis key of the host's module namespaces, by module id, that installed plugins' builds read instead of bundling. */
export const HOST_MODULES_KEY = Symbol.for('chattypop.hostModules');
/** Every platform's first host module: each process's shared step publishes it before loading plugins' shared sides. */
export const SHARED_HOST_MODULE = '@plugin-sdk/shared';

/** Platform host modules stay external to plugin builds, reusing host SDK/Solid instances so signals share one runtime. */
export const HOST_MODULES = {
  node: [SHARED_HOST_MODULE, '@plugin-sdk/core', '@plugin-sdk/main'],
  browser: [SHARED_HOST_MODULE, '@plugin-sdk/renderer', '@plugin-sdk/renderer/kit', '@plugin-sdk/renderer/posting', '@plugin-sdk/renderer/shell', 'solid-js', 'solid-js/web', 'solid-js/store'],
} as const;
export type Platform = keyof typeof HOST_MODULES;
export type HostModuleId = (typeof HOST_MODULES)[Platform][number];
/** `P`'s host modules but SHARED_HOST_MODULE: what its processes publish after their shared step. */
export type TierHostModuleId<P extends Platform> = Exclude<(typeof HOST_MODULES)[P][number], typeof SHARED_HOST_MODULE>;
/** A namespace for each of `P`'s tier modules: complete, so a module a process leaves out is a type error. */
export type TierHostModules<P extends Platform> = Record<TierHostModuleId<P>, object>;
/** Built output's folder per platform: node entries in one, browser entries and stylesheets in the other. */
export const INSTALLED_PLATFORM_DIRS: Readonly<Record<Platform, string>> = { node: 'node', browser: 'browser' };
/** Inside browser/: a page's public files, each served at the phone's root (`browser/public/sw.js` at `/sw.js`). */
export const INSTALLED_PAGE_PUBLIC_DIR = 'public';

/**
 * A plugin's page (its folder's page/), which main serves as `/<id>.html` beside the host's page bootstrap. Absent from
 * plugin.json when there is none, so format 1 stays readable.
 */
export interface InstalledPage {
  /** The page's HTML without its entry script; the host adds its bootstrap, `styles` and `entry`. */
  html: string;
  /** Its entry module, imported after the host's registry has published the host modules. */
  entry: string;
  /** Stylesheets the entry imports, linked before it loads. */
  styles: string[];
  /** Files under browser/public/, served at their path below it. */
  public: string[];
}

/** plugin.json of a built plugin. Paths are relative to the plugin folder, forward slashes, under its platform's folder. */
export interface InstalledManifest {
  format: typeof INSTALLED_FORMAT;
  id: string;
  name: string;
  version: string;
  description: string;
  /** PLUGIN_SDK_VERSION it was built against. */
  sdk: string;
  /** Node entries (core and main processes): ES modules. */
  node: { shared: string; core?: string; main?: string };
  /** Browser entries (desktop windows and the phone page): ES modules, and the stylesheets its renderer side needs. */
  browser: { shared: string; renderer?: string; styles: string[]; page?: InstalledPage };
  /** Every host-module export it imports, by module id: the loader refuses it when this host lacks one. */
  hostImports: Partial<Record<HostModuleId, string[]>>;
}

/** Where an install came from; its updates follow the same source. `installedAt` is epoch milliseconds (parseInstalledSource). */
export type InstalledSource =
  | { kind: 'release'; repo: string; tag: string; sha256: string; installedAt: number }
  | { kind: 'source'; repo: string; branch: string; commit: string; installedAt: number }
  | { kind: 'local'; path: string; installedAt: number };

/** An installed plugin the start accepted: its folder (absolute) and manifest. */
export interface InstalledPlugin {
  dir: string;
  manifest: InstalledManifest;
  source: InstalledSource | null;
}

/** One the start refused, with the reason Settings → Plugins shows. */
export interface RefusedPlugin {
  id: string;
  name: string;
  version: string;
  error: string;
}

/** What main decided at start, handed to core (INSTALLED_ENV) and to windows. Accepted ones load in build-then-id order. */
export interface InstalledStart {
  accepted: InstalledPlugin[];
  refused: RefusedPlugin[];
}

/** A version: x.y.z, numbers only. Releases and SDK versions take this form; compareVersions orders only it. */
export const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
/** `owner/name` on GitHub. */
export const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
/** Lowercase hex sha256. */
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
/** A git commit hash: SHA-1, or SHA-256 in a repo that uses it. */
export const COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** A relative path with no `.` or `..` segment. */
const PLUGIN_FILE = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._\-/]+$/;

const versionParts = (v: string): [number, number, number] => {
  const m = VERSION_PATTERN.exec(v);
  if (!m) throw new Error(`${v} is not a version like 1.2.3`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};

/** Negative when `a` is older than `b`, 0 when equal, positive when newer. Throws unless both match VERSION_PATTERN. */
export function compareVersions(a: string, b: string): number {
  const [pa, pb] = [versionParts(a), versionParts(b)];
  const at = pa.findIndex((n, i) => n !== pb[i]);
  return at < 0 ? 0 : pa[at]! - pb[at]!;
}

const text = (raw: Record<string, unknown>, key: string): string => {
  const v = raw[key];
  if (typeof v !== 'string' || !v) throw new Error(`plugin.json: ${key} must be a non-empty string`);
  return v;
};
/** A file with one of `exts` under `dir`. */
const fileUnder = (v: unknown, what: string, exts: readonly string[], dir: string): string => {
  if (typeof v !== 'string' || !PLUGIN_FILE.test(v) || !exts.some((e) => v.endsWith(e)) || !v.startsWith(dir)) throw new Error(`plugin.json: ${what} must be a relative ${exts.join(' or ')} path under ${dir}`);
  return v;
};
/** A path under `platform`'s folder (INSTALLED_PLATFORM_DIRS), the only one its loader reads. */
const entry = (v: unknown, what: string, ext: 'js' | 'css' | 'html', platform: Platform): string => fileUnder(v, what, [`.${ext}`], `${INSTALLED_PLATFORM_DIRS[platform]}/`);
const optionalEntry = (v: unknown, what: string, platform: Platform): string | undefined => (v === undefined ? undefined : entry(v, what, 'js', platform));
const record = (v: unknown, what: string): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`plugin.json: ${what} must be an object`);
  return v as Record<string, unknown>;
};

const list = (v: unknown, what: string): unknown[] => {
  if (!Array.isArray(v)) throw new Error(`plugin.json: ${what} must be a list`);
  return v;
};

/** Rejects public paths shadowed by phone installed-file routes. */
const PUBLIC_DIR = `${INSTALLED_PLATFORM_DIRS.browser}/${INSTALLED_PAGE_PUBLIC_DIR}/`;
const SHADOWED_PUBLIC_DIR = `${PUBLIC_DIR}${INSTALLED_PHONE_PATH.slice(1)}`;

/** browser.page, when present. */
function page(v: unknown): InstalledPage | undefined {
  if (v === undefined) return undefined;
  const p = record(v, 'browser.page');
  const publicFiles = list(p['public'] ?? [], 'browser.page.public').map((f, i) => {
    const file = fileUnder(f, `browser.page.public[${i}]`, Object.keys(INSTALLED_CONTENT_TYPES), PUBLIC_DIR);
    if (file.startsWith(SHADOWED_PUBLIC_DIR)) throw new Error(`plugin.json: browser.page.public[${i}] would be served under ${INSTALLED_PHONE_PATH}, the installed plugins' own path`);
    return file;
  });
  return {
    html: entry(p['html'], 'browser.page.html', 'html', 'browser'),
    entry: entry(p['entry'], 'browser.page.entry', 'js', 'browser'),
    styles: list(p['styles'] ?? [], 'browser.page.styles').map((s, i) => entry(s, `browser.page.styles[${i}]`, 'css', 'browser')),
    public: publicFiles,
  };
}

/** plugin.json as this host reads it; throws the reason it is refused. */
export function parseInstalledManifest(raw: unknown): InstalledManifest {
  const m = record(raw, 'the manifest');
  if (m['format'] !== INSTALLED_FORMAT) throw new Error(`plugin.json: format ${String(m['format'])} is not ${INSTALLED_FORMAT}, the one this ChattyPop reads`);
  const id = text(m, 'id');
  if (!PLUGIN_ID_PATTERN.test(id)) throw new Error(`plugin.json: id must match ${PLUGIN_ID_PATTERN}`);
  const sdk = text(m, 'sdk');
  if (!VERSION_PATTERN.test(sdk)) throw new Error('plugin.json: sdk must be a version like 1.2.0');
  const node = record(m['node'], 'node');
  const browser = record(m['browser'], 'browser');
  const styles = list(browser['styles'] ?? [], 'browser.styles');
  const imports = record(m['hostImports'] ?? {}, 'hostImports');
  const known = new Set<string>([...HOST_MODULES.node, ...HOST_MODULES.browser]);
  for (const [id, names] of Object.entries(imports)) {
    if (!known.has(id)) throw new Error(`plugin.json: hostImports names ${id}, which the host doesn't provide`);
    if (!Array.isArray(names) || !names.every((n) => typeof n === 'string')) throw new Error(`plugin.json: hostImports.${id} must be a list of names`);
  }
  const core = optionalEntry(node['core'], 'node.core', 'node');
  const main = optionalEntry(node['main'], 'node.main', 'node');
  const renderer = optionalEntry(browser['renderer'], 'browser.renderer', 'browser');
  const pageOf = page(browser['page']);
  return {
    format: INSTALLED_FORMAT,
    id,
    name: text(m, 'name'),
    version: text(m, 'version'),
    description: typeof m['description'] === 'string' ? m['description'] : '',
    sdk,
    node: { shared: entry(node['shared'], 'node.shared', 'js', 'node'), ...(core ? { core } : {}), ...(main ? { main } : {}) },
    browser: {
      shared: entry(browser['shared'], 'browser.shared', 'js', 'browser'),
      ...(renderer ? { renderer } : {}),
      styles: styles.map((s, i) => entry(s, `browser.styles[${i}]`, 'css', 'browser')),
      ...(pageOf ? { page: pageOf } : {}),
    },
    hostImports: imports as InstalledManifest['hostImports'],
  };
}

/** Every file `m` names, relative to its plugin folder: a build lacking one is refused. */
export function manifestFiles(m: InstalledManifest): string[] {
  const p = m.browser.page;
  return [m.node.shared, m.node.core, m.node.main, m.browser.shared, m.browser.renderer, ...m.browser.styles, ...(p ? [p.html, p.entry, ...p.styles, ...p.public] : [])].filter((f): f is string => f !== undefined);
}

/** source.json as this host reads it, each kind's fields checked; null when it isn't one (it never refuses a plugin). */
export function parseInstalledSource(raw: unknown): InstalledSource | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  const str = (key: string, pattern?: RegExp): string | null => {
    const v = s[key];
    return typeof v === 'string' && v !== '' && (!pattern || pattern.test(v)) ? v : null;
  };
  const installedAt = s['installedAt'];
  if (typeof installedAt !== 'number' || !Number.isSafeInteger(installedAt) || installedAt < 0) return null;
  if (s['kind'] === 'release') {
    const [repo, tag, sha256] = [str('repo', REPO_PATTERN), str('tag'), str('sha256', SHA256_PATTERN)];
    return repo && tag && sha256 ? { kind: 'release', repo, tag, sha256, installedAt } : null;
  }
  if (s['kind'] === 'source') {
    const [repo, branch, commit] = [str('repo', REPO_PATTERN), str('branch'), str('commit', COMMIT_PATTERN)];
    return repo && branch && commit ? { kind: 'source', repo, branch, commit, installedAt } : null;
  }
  const path = s['kind'] === 'local' ? str('path') : null;
  return path ? { kind: 'local', path, installedAt } : null;
}

/** Why a plugin built against SDK `built` can't run on SDK `host`; null when it can (same major, no newer minor). */
export function sdkMismatch(built: string, host: string = PLUGIN_SDK_VERSION): string | null {
  const [bMajor, bMinor] = versionParts(built);
  const [hMajor, hMinor] = versionParts(host);
  if (bMajor !== hMajor) return `built for plugin SDK ${built}; this ChattyPop provides ${host}. Rebuild it for SDK ${hMajor}.`;
  if (bMinor > hMinor) return `built for plugin SDK ${built}, newer than this ChattyPop's ${host}. Update ChattyPop.`;
  return null;
}

/** The host-module exports `manifest` imports that `provided` (module id → its namespace) lacks, as `module: name`. */
export function missingHostImports(manifest: InstalledManifest, provided: Readonly<Record<string, object | undefined>>): string[] {
  return Object.entries(manifest.hostImports).flatMap(([id, names]) => {
    const ns = provided[id];
    return (names ?? []).filter((n) => !ns || !(n in ns)).map((n) => `${id}: ${n}`);
  });
}
