// Selected plugin pages build as <id>.html; relative scripts resolve within the plugin and public files copy to the output. Excluded plugins ship no page.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INSTALLED_PAGE_BOOTSTRAP, PAGE_BOOTSTRAP, pageInputs, pagesPlugin } from '../bundledPlugins';
import { INSTALLED_PAGE_SHELL } from '@shared/installedBrowser';
import { rendererPages, staticFile } from '../src/main/plugins/pages';
import { tempDir } from './helpers';

const HTML = '<!doctype html><html><body><script type="module" src="./main.tsx"></script></body></html>';

/** A plugin repo clone's plugins folder, as the dev loop names it: `probe` with a page, `other` without. */
function project(): { plugins: string; rendererRoot: string; page: string } {
  const root = tempDir();
  const plugins = join(root, 'plugins');
  const page = join(plugins, 'probe/page');
  mkdirSync(join(page, 'public/install'), { recursive: true });
  mkdirSync(join(plugins, 'other/renderer'), { recursive: true });
  writeFileSync(join(page, 'index.html'), HTML);
  writeFileSync(join(page, 'public/sw.js'), 'self');
  writeFileSync(join(page, 'public/install/icon.png'), 'png');
  return { plugins, rendererRoot: join(root, 'src/renderer'), page };
}

type Hook = (...args: unknown[]) => unknown;
const hook = (plugin: object, name: string): Hook => (plugin as Record<string, Hook>)[name]!;

describe('plugin pages', () => {
  const shell = (rendererRoot: string) => ({ 'installed-page': join(rendererRoot, INSTALLED_PAGE_SHELL) });

  it('adds a build input per selected plugin page, named at the renderer root, and always the installed-page shell', () => {
    const { plugins, rendererRoot } = project();
    expect(pageInputs(rendererRoot, { dirs: plugins })).toEqual({ probe: join(rendererRoot, 'probe.html'), ...shell(rendererRoot) });
    expect(pageInputs(rendererRoot, { dirs: plugins, selection: 'other' })).toEqual(shell(rendererRoot));
  });

  it('builds the installed-page shell: a head holding only the installed pages’ bootstrap', () => {
    const { plugins, rendererRoot } = project();
    const plugin = pagesPlugin(rendererRoot, { dirs: plugins });
    const html = shell(rendererRoot)['installed-page'];
    expect(hook(plugin, 'resolveId')(html, undefined)).toBe(html);
    expect(/<head>\s*<script type="module" src="([^"]+)"><\/script>\s*<\/head>/.exec(hook(plugin, 'load')(html) as string)?.[1]).toBe(INSTALLED_PAGE_BOOTSTRAP);
    expect(existsSync(join(resolve(import.meta.dirname, '../src/renderer'), INSTALLED_PAGE_BOOTSTRAP))).toBe(true);
  });

  it('refuses a plugin page that would replace the shell', () => {
    const { plugins, rendererRoot } = project();
    mkdirSync(join(plugins, 'installed-page/page'), { recursive: true });
    writeFileSync(join(plugins, 'installed-page/page/index.html'), HTML);
    expect(() => pageInputs(rendererRoot, { dirs: plugins })).toThrow(/would replace the host's installed-page.html/);
  });

  it('loads the page from its plugin folder, after the host bootstrap, and resolves its relative scripts there', () => {
    const { plugins, rendererRoot, page } = project();
    const plugin = pagesPlugin(rendererRoot, { dirs: plugins });
    const html = pageInputs(rendererRoot, { dirs: plugins })['probe']!;
    expect(hook(plugin, 'resolveId')(html, undefined)).toBe(html);
    expect(hook(plugin, 'load')(html)).toBe(
      HTML.replace('<script type="module"', `<script type="module" src="${PAGE_BOOTSTRAP}"></script>
    <script type="module"`),
    );
    expect(existsSync(join(resolve(import.meta.dirname, '../src/renderer'), PAGE_BOOTSTRAP))).toBe(true);
    expect(hook(plugin, 'resolveId')('./main.tsx', html)).toBe(join(page, 'main.tsx'));
    expect(hook(plugin, 'resolveId')('./main.tsx', join(rendererRoot, 'index.html'))).toBeUndefined();
    expect(hook(plugin, 'load')(join(rendererRoot, 'index.html'))).toBeUndefined();
  });

  it('copies the page’s public files to the output root, and none for a plugin left out', () => {
    const { plugins, rendererRoot } = project();
    const emitted = (selection?: string): string[] => {
      const files: string[] = [];
      hook(pagesPlugin(rendererRoot, { dirs: plugins, selection }), 'generateBundle').call({ emitFile: (f: { fileName: string }) => files.push(f.fileName) });
      return files.sort();
    };
    expect(emitted()).toEqual(['install/icon.png', 'sw.js']);
    expect(emitted('none')).toEqual([]);
  });
});

describe('a transport page', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reaches only the server that served it, and installs the phone API over its transport and the media root', async () => {
    const fetched: unknown[] = [];
    vi.stubGlobal('fetch', async (url: string) => void fetched.push(url));
    vi.stubGlobal('window', {});
    // Renderer modules (DOM types): imported by path so the node type-check doesn't follow them.
    const transportPath = '@plugin-sdk/renderer/shell/transport';
    const phoneApiPath = '@plugin-sdk/renderer/shell/phoneApi';
    const { installRendererApi, pageFetch } = (await import(transportPath)) as {
      installRendererApi: (api: unknown, mediaRoot: string) => void;
      pageFetch: (path: string) => Promise<unknown>;
    };
    const { createPhoneRendererApi } = (await import(phoneApiPath)) as {
      createPhoneRendererApi: (t: { call(c: { group: string; method: string; params: unknown[] }): Promise<unknown>; listen(deliver: unknown): void }) => unknown;
    };
    const { mediaUrl } = await import('@shared/media');
    await pageFetch('/rpc');
    expect(fetched).toEqual(['/rpc']);
    for (const url of ['https://elsewhere.example/', '//elsewhere.example/x', 'rpc']) expect(() => pageFetch(url)).toThrow(/Not a path/);
    const call = vi.fn(async () => 'up');
    installRendererApi(createPhoneRendererApi({ call, listen: () => undefined }), '/media/');
    const leaf = '@/api';
    const { api } = (await import(leaf)) as {
      api: { core: { status(): Promise<string> }; plugins: { callCore(id: string, name: string, args: unknown[]): Promise<unknown> } };
    };
    await expect(api.core.status()).resolves.toBe('up');
    expect(call).toHaveBeenCalledExactlyOnceWith({ group: 'core', method: 'status', params: [] });
    // A plugin member for desktop windows only is refused on the phone, never sent.
    await expect(api.plugins.callCore('plans', 'list', [1])).rejects.toThrow(/only on the desktop/);
    expect(call).toHaveBeenCalledOnce();
    expect(mediaUrl('avatar', '1')).toBe('/media/avatar/1');
  });
});

describe('the renderer’s pages as replies (main ctx.pages)', () => {
  it('serves a built file with its type and length, and 404 for one missing or outside the build', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'probe.html'), 'page');
    const pages = rendererPages(dir, null);
    const page = await pages.response('/probe.html');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('content-length')).toBe('4');
    expect(await page.text()).toBe('page');
    for (const path of ['/missing.js', '/../x', '/%2e%2e/x', '/%E0%A4%A', '/']) expect((await pages.response(path)).status).toBe(404);
    expect(staticFile(dir, '/a%00b')).toBeNull();
  });

  it('forwards to the dev server in development, and answers 502 while it is down', async () => {
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (url: URL) => {
      fetched.push(url.href);
      return new Response('dev');
    });
    expect(await (await rendererPages('', 'http://localhost:5173').response('/probe.html', '?v=1')).text()).toBe('dev');
    expect(fetched).toEqual(['http://localhost:5173/probe.html?v=1']);
    vi.stubGlobal('fetch', async () => Promise.reject(new Error('down')));
    expect((await rendererPages('', 'http://localhost:5173').response('/probe.html')).status).toBe(502);
    vi.unstubAllGlobals();
  });

  it('keeps every dev request on the dev server’s origin, whatever the path, and follows no redirect', async () => {
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (url: URL, init?: RequestInit) => {
      fetched.push(url.href);
      if (init?.redirect !== 'error' && url.pathname === '/moved') return Response.redirect('http://127.0.0.1:9337/json', 302);
      if (url.pathname === '/moved') throw new TypeError('redirect');
      return new Response('dev');
    });
    const pages = rendererPages('', 'http://localhost:5173');
    for (const path of ['//127.0.0.1:9337/json', '/\\127.0.0.1:9337/json']) await pages.response(path);
    expect((await pages.response('http://127.0.0.1:9337/json')).status).toBe(404);
    expect(fetched.map((u) => new URL(u).origin)).toEqual(['http://localhost:5173', 'http://localhost:5173']);
    expect((await pages.response('/moved')).status).toBe(502);
    vi.unstubAllGlobals();
  });
});
