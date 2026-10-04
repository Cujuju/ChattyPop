// The installed-plugin and marketplace contracts (docs/plugin-architecture.md §16): versions and how they order, and
// what the shared parsers accept and refuse.
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HOST_MODULES, INSTALLED_FORMAT, PLUGIN_SDK_VERSION, SHARED_HOST_MODULE, compareVersions, manifestFiles, parseInstalledManifest, parseInstalledSource, sdkMismatch } from '@shared/installedPlugins';
import { MARKETPLACE_FORMAT, parseMarketplaceIndex } from '@shared/marketplace';
import { NO_PLUGIN_SOURCE, bundledPlugins } from '../bundledPlugins';

const ROOT = resolve(import.meta.dirname, '..');
// installedRenderers' imports that need a window; its published keys are what the test reads.
vi.mock('../src/renderer/src/plugins/installedLoader', () => ({}));
vi.mock('../src/renderer/src/plugins/installedShared', () => ({}));
vi.mock('@plugin-sdk/renderer', () => ({}));
vi.mock('@plugin-sdk/renderer/kit', () => ({}));
vi.mock('@plugin-sdk/renderer/posting', () => ({}));
vi.mock('@plugin-sdk/renderer/shell', () => ({}));

/** Hex digits in a sha256 and in a git SHA-1 commit hash, and in git's short hash. */
const SHA256_HEX_LENGTH = 64;
const SHA1_HEX_LENGTH = 40;
const SHORT_COMMIT_LENGTH = 7;

describe('versions', () => {
  it.each([
    ['1.0.0', '1.0.0', 0],
    ['1.10.0', '1.9.0', 1],
    ['1.9.9', '2.0.0', -1],
    ['1.0.10', '1.0.2', 1],
  ])('orders %s against %s numerically, part by part', (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
  });

  it.each(['1.0.0-beta', '1.0', 'v1.0.0', '', '1.0.0.0'])('refuses to order %j, which is not x.y.z', (v) => {
    expect(() => compareVersions(v, '1.0.0')).toThrow(/not a version like 1.2.3/);
    expect(() => compareVersions('1.0.0', v)).toThrow(/not a version like 1.2.3/);
    expect(() => sdkMismatch(v)).toThrow(/not a version like 1.2.3/);
  });

  it('runs a build of the same SDK major with no newer minor', () => {
    const [major, minor] = PLUGIN_SDK_VERSION.split('.').map(Number) as [number, number];
    expect(sdkMismatch(PLUGIN_SDK_VERSION)).toBeNull();
    expect(sdkMismatch(`${major}.${minor}.99`)).toBeNull();
    expect(sdkMismatch(`${major}.${minor + 1}.0`)).toMatch(/Update ChattyPop/);
    expect(sdkMismatch(`${major + 1}.0.0`)).toMatch(/Rebuild it/);
  });
});

/** A manifest the parser accepts, with `node`, `browser` and top-level fields replaced. */
const manifest = (top: object = {}, node: object = {}, browser: object = {}) => ({
  format: INSTALLED_FORMAT,
  id: 'demo',
  name: 'Demo',
  version: '1.0.0',
  sdk: PLUGIN_SDK_VERSION,
  node: { shared: 'node/shared.js', core: 'node/core.js', ...node },
  browser: { shared: 'browser/shared.js', renderer: 'browser/renderer.js', styles: ['browser/assets/a.css'], ...browser },
  hostImports: { '@plugin-sdk/shared': ['definePlugin'] },
  ...top,
});

describe('installed manifest', () => {
  it('accepts entries under their platform folder', () => {
    expect(parseInstalledManifest(manifest())).toMatchObject({ node: { shared: 'node/shared.js', core: 'node/core.js' }, browser: { styles: ['browser/assets/a.css'] } });
  });

  it.each([
    ['node.shared', { shared: 'shared.js' }, {}],
    ['node.core', { core: 'browser/core.js' }, {}],
    ['node.main', { main: 'nodes/main.js' }, {}],
    ['browser.shared', {}, { shared: 'node/shared.js' }],
    ['browser.renderer', {}, { renderer: 'renderer.js' }],
    ['browser.styles[0]', {}, { styles: ['assets/a.css'] }],
  ])('refuses %s outside its platform folder', (what, node, browser) => {
    const ext = what.startsWith('browser.styles') ? 'css' : 'js';
    expect(() => parseInstalledManifest(manifest({}, node, browser))).toThrow(`plugin.json: ${what} must be a relative .${ext} path under ${what.split('.')[0]}/`);
  });

  it.each([
    '../x.js',
    'node/../x.js',
    'node/./x.js',
    '/x.js',
    '/node/x.js',
    'a\\b.js',
    'node\\x.js',
    'node/a\\b.js',
    'C:/x.js',
    'node/C:/x.js',
    'x.ts',
    'node/x.ts',
    'node/x.css',
    'node/x.js.map',
  ])('refuses the script entry %j', (path) => {
    expect(() => parseInstalledManifest(manifest({}, { shared: path }))).toThrow('plugin.json: node.shared must be a relative .js path under node/');
  });

  it.each(['browser/x.js', 'browser/../x.css', '/browser/x.css'])('refuses the stylesheet %j', (path) => {
    expect(() => parseInstalledManifest(manifest({}, {}, { styles: [path] }))).toThrow('plugin.json: browser.styles[0] must be a relative .css path under browser/');
  });

  const page = { html: 'browser/page.html', entry: 'browser/page.js', styles: ['browser/assets/page.css'], public: ['browser/public/sw.js', 'browser/public/install/manifest.webmanifest'] };

  it('reads a page when there is one, and none when the field is absent (format 1 either way)', () => {
    const withPage = parseInstalledManifest(manifest({}, {}, { page }));
    expect(withPage.browser.page).toEqual(page);
    expect(parseInstalledManifest(manifest()).browser.page).toBeUndefined();
    expect(manifestFiles(withPage)).toEqual(['node/shared.js', 'node/core.js', 'browser/shared.js', 'browser/renderer.js', 'browser/assets/a.css', ...[page.html, page.entry, ...page.styles, ...page.public]]);
  });

  it.each([
    ['html', { html: 'node/page.html' }, 'browser.page.html must be a relative .html path under browser/'],
    ['html', { html: 'browser/../node/page.html' }, 'browser.page.html must be a relative .html path under browser/'],
    ['html', { html: 'browser/page.js' }, 'browser.page.html must be a relative .html path under browser/'],
    ['entry', { entry: '../page.js' }, 'browser.page.entry must be a relative .js path under browser/'],
    ['styles', { styles: ['node/a.css'] }, 'browser.page.styles[0] must be a relative .css path under browser/'],
    ['public', { public: ['browser/sw.js'] }, 'browser.page.public[0] must be a relative'],
    ['public', { public: ['browser/public/../shared.js'] }, 'browser.page.public[0] must be a relative'],
    ['public', { public: ['browser/public/notes.txt'] }, 'browser.page.public[0] must be a relative'],
    ['public', { public: ['browser/public/installed/index.json'] }, 'browser.page.public[0] would be served under /installed/'],
  ])('refuses a page %s that leaves its place: %j', (_what, change, error) => {
    expect(() => parseInstalledManifest(manifest({}, {}, { page: { ...page, ...change } }))).toThrow(`plugin.json: ${error}`);
  });

  it.each([
    ['an unknown module', { 'left-pad': ['pad'] }, "plugin.json: hostImports names left-pad, which the host doesn't provide"],
    ['a list for the map', ['@plugin-sdk/shared'], 'plugin.json: hostImports must be an object'],
    ['a name for a list', { '@plugin-sdk/shared': 'definePlugin' }, 'plugin.json: hostImports.@plugin-sdk/shared must be a list of names'],
    ['a list of non-names', { '@plugin-sdk/shared': [1] }, 'plugin.json: hostImports.@plugin-sdk/shared must be a list of names'],
  ])('refuses hostImports with %s', (_why, hostImports, error) => {
    expect(() => parseInstalledManifest(manifest({ hostImports }))).toThrow(error);
  });
});

const SHA1 = 'b'.repeat(SHA1_HEX_LENGTH);
const SOURCES = {
  release: { kind: 'release', repo: 'owner/market', tag: 'demo-v1.0.0', sha256: 'a'.repeat(SHA256_HEX_LENGTH), installedAt: 1 },
  source: { kind: 'source', repo: 'owner/market', branch: 'main', commit: SHA1, installedAt: 1 },
  local: { kind: 'local', path: 'C:/builds/demo', installedAt: 1 },
} as const;

describe('installed source', () => {
  it.each(Object.values(SOURCES))('reads a $kind source, keeping only its fields', (source) => {
    expect(parseInstalledSource({ ...source, extra: true })).toEqual(source);
  });

  it.each([
    ['not an object', null],
    ['a list', [SOURCES.local]],
    ['an unknown kind', { ...SOURCES.local, kind: 'folder' }],
    ['no installedAt', { ...SOURCES.local, installedAt: undefined }],
    ['a fractional installedAt', { ...SOURCES.local, installedAt: 1.5 }],
    ['a negative installedAt', { ...SOURCES.local, installedAt: -1 }],
    ['a release from a malformed repo', { ...SOURCES.release, repo: 'owner' }],
    ['a release without a tag', { ...SOURCES.release, tag: '' }],
    ['a release with an uppercase sha256', { ...SOURCES.release, sha256: 'A'.repeat(SHA256_HEX_LENGTH) }],
    ['a source from a malformed repo', { ...SOURCES.source, repo: 'a/b/c' }],
    ['a source without a branch', { ...SOURCES.source, branch: undefined }],
    ['a source at a short commit', { ...SOURCES.source, commit: SHA1.slice(0, SHORT_COMMIT_LENGTH) }],
    ['a local build without a path', { ...SOURCES.local, path: '' }],
  ])('refuses %s', (_why, raw) => {
    expect(parseInstalledSource(raw)).toBeNull();
  });
});

describe('host modules each platform publishes', () => {
  const sorted = (ids: Iterable<string>): string[] => [...new Set(ids)].sort();

  it("node: the shared step's and core's and main's registries publish HOST_MODULES.node, each after the shared SDK", () => {
    const plugin = bundledPlugins(ROOT, 'node', NO_PLUGIN_SOURCE);
    const load = (id: string): string => (plugin.load as (id: string) => string)((plugin.resolveId as (id: string) => string)(id));
    const published = ['virtual:installed-plugins/shared', 'virtual:bundled-plugins/core', 'virtual:bundled-plugins/main'].map((id) =>
      [...load(id).matchAll(/^import \* as \w+ from "([^"]+)";$/gm)].map((m) => m[1]!),
    );
    expect(published.map((ids) => ids[0])).toEqual([SHARED_HOST_MODULE, SHARED_HOST_MODULE, SHARED_HOST_MODULE]);
    expect(sorted(published.flat())).toEqual(sorted(HOST_MODULES.node));
  });

  it("browser: the shared SDK and the renderer step's modules are HOST_MODULES.browser", async () => {
    // A renderer module: imported by path so the node type-check doesn't follow it.
    const renderers = '../src/renderer/src/plugins/installedRenderers';
    const { RENDERER_HOST_MODULES } = (await import(renderers)) as { RENDERER_HOST_MODULES: Record<string, object> };
    expect(sorted([SHARED_HOST_MODULE, ...Object.keys(RENDERER_HOST_MODULES)])).toEqual(sorted(HOST_MODULES.browser));
  });
});

const release = (version: string, more: object = {}) => ({ version, tag: `demo-v${version}`, asset: 'demo.tar.gz', sha256: 'a'.repeat(SHA256_HEX_LENGTH), sdk: PLUGIN_SDK_VERSION, ...more });
const indexOf = (plugin: object, ...more: object[]) => ({ format: MARKETPLACE_FORMAT, plugins: [{ id: 'demo', name: 'Demo', releases: [release('1.0.0')], ...plugin }, ...more] });

describe('marketplace index', () => {
  it('lists releases newest first whatever order the file has', () => {
    const parsed = parseMarketplaceIndex(indexOf({ releases: [release('1.0.0'), release('1.10.0'), release('1.2.0')] }));
    expect(parsed.plugins[0]!.releases.map((r) => r.version)).toEqual(['1.10.0', '1.2.0', '1.0.0']);
  });

  it('refuses a version listed twice', () => {
    expect(() => parseMarketplaceIndex(indexOf({ releases: [release('1.0.0'), release('1.1.0'), release('1.0.0', { tag: 'again' })] }))).toThrow('plugin demo lists version 1.0.0 twice');
  });

  it('accepts a source folder inside the repo', () => {
    expect(parseMarketplaceIndex(indexOf({ source: { path: 'plugins/demo', branch: 'main' } })).plugins[0]!.source).toEqual({ path: 'plugins/demo', branch: 'main' });
  });

  it('gives every plugin without a source its plugins/<id> folder on the repo\'s default branch', () => {
    const parsed = parseMarketplaceIndex(indexOf({}, { id: 'own', name: 'Own', releases: [], source: { path: 'elsewhere/own', branch: 'dev' } }), 'trunk');
    expect(parsed.plugins.map((p) => p.source)).toEqual([{ path: 'plugins/demo', branch: 'trunk' }, { path: 'elsewhere/own', branch: 'dev' }]);
    // The file alone (release scripts read it so) adds none.
    expect(parseMarketplaceIndex(indexOf({})).plugins[0]!.source).toBeUndefined();
  });

  it.each<[string, unknown, string]>([
    ['a plugin id listed twice', indexOf({}, { id: 'demo', name: 'Again', releases: [] }), 'plugin demo is listed twice'],
    ...['../x', './x', '/x', 'a/../x', 'a\\x'].map((path) => [`source.path ${path}`, indexOf({ source: { path, branch: 'main' } }), 'plugins[0].source.path is missing or malformed'] as [string, unknown, string]),
    ['an uppercase sha256', indexOf({ releases: [release('1.0.0', { sha256: 'A'.repeat(SHA256_HEX_LENGTH) })] }), 'plugins[0].releases[0].sha256 is missing or malformed'],
    ['a short sha256', indexOf({ releases: [release('1.0.0', { sha256: 'a'.repeat(SHA256_HEX_LENGTH - 1) })] }), 'plugins[0].releases[0].sha256 is missing or malformed'],
    ['an sdk that is not x.y.z', indexOf({ releases: [release('1.0.0', { sdk: '1.0' })] }), 'plugins[0].releases[0].sdk is missing or malformed'],
    ['a version that is not x.y.z', indexOf({ releases: [release('1.0.0-beta')] }), 'plugins[0].releases[0].version is missing or malformed'],
  ])('refuses %s', (_why, raw, error) => {
    expect(() => parseMarketplaceIndex(raw)).toThrow(`marketplace.json: ${error}`);
  });
});
