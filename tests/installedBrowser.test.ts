// Serves accepted installed-plugin browser files only. Loaders publish host modules first and omit failed plugins.
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INSTALLED_INDEX, INSTALLED_PAGE_ENTRY_META, INSTALLED_PAGE_SHELL, INSTALLED_PHONE_PATH } from '@shared/installedBrowser';
import { HOST_MODULES_KEY, INSTALLED_FORMAT, PLUGIN_SDK_VERSION, type InstalledManifest, type InstalledPlugin } from '@shared/installedPlugins';
import { installedFiles } from '../src/main/plugins/installedFiles';
import { rendererPages } from '../src/main/plugins/pages';
import { tempDir } from './helpers';

const manifest = (id: string, browser: Partial<InstalledManifest['browser']> = {}, hostImports: InstalledManifest['hostImports'] = {}): InstalledManifest => ({
  format: INSTALLED_FORMAT,
  id,
  name: id,
  version: '1.0.0',
  description: '',
  sdk: PLUGIN_SDK_VERSION,
  node: { shared: 'node/shared.js' },
  browser: { shared: 'browser/shared.js', renderer: 'browser/renderer.js', styles: [], ...browser },
  hostImports,
});

/** A built plugin folder with `files` under browser/, and a private file beside it. */
function builtPlugin(id: string, files: Record<string, string>, browser: Partial<InstalledManifest['browser']> = {}): InstalledPlugin {
  const dir = join(tempDir(), id);
  mkdirSync(join(dir, 'browser', 'chunks'), { recursive: true });
  mkdirSync(join(dir, 'node'), { recursive: true });
  writeFileSync(join(dir, 'node', 'core.js'), 'secret');
  writeFileSync(join(dir, 'node', 'secret.html'), 'secret');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, 'browser', name)), { recursive: true });
    writeFileSync(join(dir, 'browser', name), text);
  }
  return { dir, manifest: manifest(id, browser), source: null };
}

describe('installed plugins’ browser files (main)', () => {
  const probe = builtPlugin('probe', { 'shared.js': 'export default 1;', 'chunks/a.js': 'a', 'look.css': 'b', 'notes.txt': 'c' });
  const files = installedFiles([probe]);

  it('serves the index of accepted manifests, at a name no plugin id can take', async () => {
    const r = await files.response(INSTALLED_INDEX, '/');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/json');
    expect(await r.json()).toEqual([probe.manifest]);
    expect((await files.response(INSTALLED_INDEX, '/x')).status).toBe(404);
  });

  it('serves files under browser/ with their type, CORS and no caching', async () => {
    const r = await files.response('probe', '/browser/chunks/a.js');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.text()).toBe('a');
    expect((await files.response('probe', '/browser/look.css')).headers.get('content-type')).toBe('text/css; charset=utf-8');
  });

  it('refuses paths outside browser/, untyped files, unknown plugins and missing files', async () => {
    for (const path of ['/node/core.js', '/browser/../node/core.js', '/browser/%2e%2e/node/core.js', '/browser/..%5Cnode%5Ccore.js', '/plugin.json', '/../probe/node/core.js']) expect((await files.response('probe', path)).status).toBe(403);
    for (const path of ['/browser/notes.txt', '/browser/chunks']) expect((await files.response('probe', path)).status).toBe(403);
    for (const path of ['/browser/missing.js', '/%E0%A4%A.js', '/browser/a%00.js']) expect((await files.response('probe', path)).status).toBe(404);
    expect((await files.response('other', '/browser/shared.js')).status).toBe(404);
  });

  it('refuses a link inside browser/ that leads out of it', async (ctx) => {
    const outside = join(tempDir(), 'leak.js');
    writeFileSync(outside, 'leak');
    try {
      symlinkSync(outside, join(probe.dir, 'browser', 'leak.js'));
    } catch {
      ctx.skip(); // Windows without the privilege to make links.
    }
    expect((await files.response('probe', '/browser/leak.js')).status).toBe(403);
  });

  it('reaches the phone through the Companion’s pages, in development too', async () => {
    for (const pages of [rendererPages(tempDir(), null, files), rendererPages('', 'http://localhost:5173', files)]) {
      expect(await (await pages.response(`${INSTALLED_PHONE_PATH}${INSTALLED_INDEX}`)).json()).toEqual([probe.manifest]);
      expect(await (await pages.response(`${INSTALLED_PHONE_PATH}probe/browser/chunks/a.js`)).text()).toBe('a');
      expect((await pages.response(`${INSTALLED_PHONE_PATH}probe/node/core.js`)).status).toBe(403);
    }
    expect((await rendererPages(tempDir(), null).response(`${INSTALLED_PHONE_PATH}${INSTALLED_INDEX}`)).status).toBe(404);
  });
});

describe('installed plugins’ pages (main ctx.pages)', () => {
  const page = { html: 'browser/page.html', entry: 'browser/page.js', styles: ['browser/assets/page.css'], public: ['browser/public/sw.js', 'browser/public/install/icon.png'] };
  const TEMPLATE = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src \'self\'"></head><body><div id="root"></div></body></html>';
  const phone = builtPlugin('phone', { 'page.html': TEMPLATE, 'page.js': 'entry', 'public/sw.js': 'worker', 'public/install/icon.png': 'png' }, { page });
  const later = builtPlugin('later', { 'page.html': TEMPLATE, 'public/sw.js': 'other worker' }, { page: { ...page, public: ['browser/public/sw.js'] } });
  const SHELL_HEAD = '<script type="module" crossorigin src="./assets/installed-page-x.js"></script>';
  /** A renderer build with the installed-page shell, as the host's build writes it. */
  const build = (): string => {
    const dir = tempDir();
    writeFileSync(join(dir, INSTALLED_PAGE_SHELL), `<!doctype html>\n<html>\n  <head>\n    ${SHELL_HEAD}\n  </head>\n  <body></body>\n</html>\n`);
    writeFileSync(join(dir, 'index.html'), 'app');
    return dir;
  };

  it('serves the page at /<id>.html as HTML: its own head first, then the shell’s bootstrap, its stylesheets and its entry', async () => {
    const r = await rendererPages(build(), null, installedFiles([phone, later])).response('/phone.html');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await r.text();
    expect(r.headers.get('content-length')).toBe(String(new TextEncoder().encode(html).byteLength));
    expect(html).toBe(TEMPLATE.replace('</head>', [
      SHELL_HEAD,
      `<link rel="stylesheet" href="${INSTALLED_PHONE_PATH}phone/browser/assets/page.css">`,
      `<meta name="${INSTALLED_PAGE_ENTRY_META}" content="${INSTALLED_PHONE_PATH}phone/browser/page.js">`,
      '</head>',
    ].join('\n')));
  });

  it('takes the shell from the dev server in development', async () => {
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (url: URL) => {
      fetched.push(url.href);
      return new Response(`<html><head>${SHELL_HEAD}</head></html>`);
    });
    try {
      expect(await (await rendererPages('', 'http://localhost:5173', installedFiles([phone])).response('/phone.html')).text()).toContain(SHELL_HEAD);
      expect(fetched).toEqual([`http://localhost:5173/${INSTALLED_PAGE_SHELL}`]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('serves its public files at their own path, the first plugin in load order winning, ahead of the build', async () => {
    const pages = rendererPages(build(), null, installedFiles([phone, later]));
    const sw = await pages.response('/sw.js');
    expect(sw.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await sw.text()).toBe('worker');
    expect((await pages.response('/install/icon.png')).headers.get('content-type')).toBe('image/png');
    expect(await (await pages.response('/index.html')).text()).toBe('app');
  });

  it('answers 404 for a page no accepted plugin has, or whose HTML is missing', async () => {
    const pages = rendererPages(build(), null, installedFiles([phone, builtPlugin('bare', {}, { page })]));
    for (const path of ['/nope.html', '/probe.html', '/bare.html', '/install/missing.png']) expect((await pages.response(path)).status).toBe(404);
  });

  it('serves a page’s HTML only from browser/, and never through /installed/', async () => {
    const escaping = builtPlugin('escaping', {}, { page: { ...page, html: 'browser/../node/secret.html' } });
    const pages = rendererPages(build(), null, installedFiles([phone, escaping]));
    expect((await pages.response('/escaping.html')).status).toBe(403);
    expect((await pages.response(`${INSTALLED_PHONE_PATH}phone/browser/page.html`)).status).toBe(403);
  });

  it('answers 500 when the build lacks the shell', async () => {
    expect((await rendererPages(tempDir(), null, installedFiles([phone])).response('/phone.html')).status).toBe(500);
  });
});

// A renderer module (DOM types): imported by path so the node type-check doesn't follow it.
const loaderPath = '../src/renderer/src/plugins/installedLoader';
type Loaded = { manifest: InstalledManifest; descriptor: { manifest: { id: string } } };
const { loadRenderers, loadShared } = (await import(loaderPath)) as {
  loadShared(io: unknown, sdkShared: object, build: readonly object[], catalog: null): Promise<Loaded[]>;
  loadRenderers(io: unknown, shared: readonly Loaded[], modules: Record<string, object>): Promise<{ plugin: { manifest: { id: string } } }[]>;
};

const descriptor = (id: string, slots?: object) => ({ manifest: { id, name: id, version: '1', description: '' }, ...(slots ? { slots } : {}) });
const published = (): Record<string, object> => (globalThis as Record<symbol, Record<string, object>>)[HOST_MODULES_KEY] ?? {};

/** A stand-in for a window: `modules` by URL (a function throws), stylesheets that fail when named in `badStyles`. */
function fakeIo(index: unknown, modules: Record<string, Record<string, unknown> | (() => never)>, badStyles: string[] = []) {
  const log: string[] = [];
  const styles: string[] = [];
  const reports: [string | null, string][] = [];
  const io = {
    index: async () => (index instanceof Error ? Promise.reject(index) : index),
    url: (id: string, file: string) => `x://${id}/${file}`,
    load: async (url: string) => {
      log.push(`load ${url} with ${Object.keys(published()).join(',')}`);
      const m = modules[url];
      if (!m) throw new Error(`404 ${url}`);
      return typeof m === 'function' ? m() : m;
    },
    stylesheet: async (url: string) => {
      log.push(`style ${url}`);
      if (badStyles.includes(url)) throw new Error(`bad ${url}`);
      styles.push(url);
      return () => styles.splice(styles.indexOf(url), 1);
    },
    report: (id: string | null, err: unknown) => reports.push([id, String(err)]),
  };
  return { io, log, styles, reports };
}

describe('the installed plugins’ loaders (windows and the phone page)', () => {
  beforeEach(() => void delete (globalThis as Record<symbol, unknown>)[HOST_MODULES_KEY]);

  it('publishes the shared SDK, then loads each shared.js in index order, leaving out one that fails', async () => {
    const sdk = { defineThing: 1 };
    const index = [manifest('pa'), manifest('pb'), manifest('pc'), manifest('pd', {}, { '@plugin-sdk/shared': ['defineThing', 'missing'] }), { id: 'pe', format: 9 }];
    const { io, log, reports } = fakeIo(index, {
      'x://pa/browser/shared.js': { default: descriptor('pa') },
      'x://pb/browser/shared.js': () => {
        throw new Error('syntax');
      },
      'x://pc/browser/shared.js': { default: descriptor('other') },
    });
    const loaded = await loadShared(io, sdk, [], null);
    expect(loaded.map((p) => p.descriptor.manifest.id)).toEqual(['pa']);
    expect(published()['@plugin-sdk/shared']).toBe(sdk);
    expect(log).toEqual(['load x://pa/browser/shared.js with @plugin-sdk/shared', 'load x://pb/browser/shared.js with @plugin-sdk/shared', 'load x://pc/browser/shared.js with @plugin-sdk/shared']);
    expect(reports.map(([id]) => id)).toEqual(['pe', 'pb', 'pc', 'pd']);
    expect(reports[3]![1]).toMatch(/@plugin-sdk\/shared: missing/);
  });

  it('keeps a plugin anchored on one that failed here, its items appended, instead of failing the registry', async () => {
    const panel = (id: string, after?: string) => ({ panels: [{ id, title: 'P', importance: 'reference', dialog: false, iconPath: '', ...(after ? { after } : {}) }] });
    const { io, reports } = fakeIo([manifest('pa'), manifest('pb'), manifest('pc')], {
      'x://pa/browser/shared.js': () => {
        throw new Error('fetch failed');
      },
      'x://pb/browser/shared.js': { default: { ...descriptor('pb'), ...panel('pb-panel', 'pa-panel') } },
      'x://pc/browser/shared.js': { default: { ...descriptor('pc'), ...panel('pc-panel') } },
    });
    const loaded = await loadShared(io, {}, [], null);
    expect(loaded.map((p) => p.descriptor.manifest.id)).toEqual(['pb', 'pc']);
    expect(reports.map(([id]) => id)).toEqual(['pa']);
  });

  it('loads none, and reports it, when the index can’t be read', async () => {
    for (const index of [new Error('401'), { not: 'a list' }]) {
      const { io, reports } = fakeIo(index, {});
      expect(await loadShared(io, {}, [], null)).toEqual([]);
      expect(reports.map(([id]) => id)).toEqual([null]);
    }
  });

  it('publishes the renderer modules, adds each plugin’s stylesheets before its renderer.js, and leaves out one that fails', async () => {
    const tiers = { '@plugin-sdk/renderer': { a: 1 }, 'solid-js': { b: 1 } };
    const shared = (m: InstalledManifest, slots?: object): Loaded => ({ manifest: m, descriptor: descriptor(m.id, slots) });
    const entry = (id: string, contributions: object = {}) => ({ default: { plugin: descriptor(id, { topBar: [{ id: 'bell' }] }), contributions } });
    const { io, log, styles, reports } = fakeIo(null, {
      'x://ok/browser/renderer.js': entry('ok', { topBar: { bell: {} } }),
      'x://noview/browser/renderer.js': entry('noview'),
      'x://throws/browser/renderer.js': () => {
        throw new Error('boom');
      },
    }, ['x://badstyle/b.css']);
    const entries = await loadRenderers(io, [
      shared(manifest('ok', { styles: ['a.css', 'b.css'] })),
      shared(manifest('badstyle', { styles: ['a.css', 'b.css'] })),
      shared(manifest('noview', { styles: ['a.css'] })),
      shared(manifest('throws')),
      shared(manifest('bare', { renderer: undefined, styles: ['a.css'] })),
      shared(manifest('slotless', { renderer: undefined }), { topBar: [{ id: 'bell' }] }),
      shared(manifest('lacks', {}, { 'solid-js': ['b', 'createGhost'] })),
    ], tiers);
    expect(entries.map((e) => e.plugin.manifest.id)).toEqual(['ok']);
    expect(published()).toMatchObject(tiers);
    // Stylesheets apply before the renderer.js loads; a failed plugin's are removed and its renderer.js never loads.
    expect(log.slice(0, 3)).toEqual(['style x://ok/a.css', 'style x://ok/b.css', 'load x://ok/browser/renderer.js with @plugin-sdk/renderer,solid-js']);
    expect(log).not.toContain('load x://badstyle/browser/renderer.js with @plugin-sdk/renderer,solid-js');
    expect(styles).toEqual(['x://ok/a.css', 'x://ok/b.css', 'x://bare/a.css']);
    expect(reports.map(([id]) => id)).toEqual(['badstyle', 'noview', 'throws', 'slotless', 'lacks']);
    expect(reports[4]![1]).toMatch(/solid-js: createGhost/);
  });
});
