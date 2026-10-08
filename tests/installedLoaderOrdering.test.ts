import { afterEach, describe, expect, it, vi } from 'vitest';
import { INSTALLED_PAGE_ENTRY_META, pageSectionKey } from '@shared/installedBrowser';
import { INSTALLED_FORMAT, PLUGIN_SDK_VERSION, type InstalledManifest } from '@shared/installedPlugins';
import type { PluginDescriptor } from '@shared/bundledTypes';

type Loaded = { manifest: InstalledManifest; descriptor: PluginDescriptor };
const LOADER_PATH = '../src/renderer/src/plugins/installedLoader';
const { loadShared, loadRenderers, windowIo } = (await import(LOADER_PATH)) as {
  loadShared(io: unknown, sdk: object, build: readonly object[], catalog: null): Promise<Loaded[]>;
  loadRenderers(io: unknown, shared: readonly Loaded[], modules: object): Promise<{ plugin: PluginDescriptor }[]>;
  windowIo(): { page?: { id: string; section: string | null } };
};

function plugin(id: string, extra: Partial<PluginDescriptor> = {}): Loaded {
  return {
    manifest: {
      format: INSTALLED_FORMAT, id, name: id, version: '1.0.0', description: '', sdk: PLUGIN_SDK_VERSION,
      node: { shared: 'node/shared.js' },
      browser: { shared: 'browser/shared.js', renderer: 'browser/renderer.js', styles: [] }, hostImports: {},
    },
    descriptor: { manifest: { id, name: id, version: '1.0.0', description: '' }, ...extra },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const settle = () => new Promise((done) => setTimeout(done, 0));

describe('installed browser import scheduling', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('gets page priority from the bootstrap entry, including versioned entries and blocked storage', () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', { querySelector: (selector: string) => {
      expect(selector).toBe(`meta[name="${INSTALLED_PAGE_ENTRY_META}"]`);
      return { content: '/installed/page/browser/cp-version/page.js' };
    } });
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => {
      expect(key).toBe(pageSectionKey('page'));
      return 'inbox.feed';
    } });
    expect(windowIo().page).toEqual({ id: 'page', section: 'inbox.feed' });
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('Blocked'); } });
    expect(windowIo().page).toEqual({ id: 'page', section: null });
    vi.stubGlobal('window', { chattypop: {} });
    expect(windowIo().page).toBeUndefined();
  });

  it('starts the page shared module first, overlaps independent imports, and validates in index order', async () => {
    const plugins = [plugin('background'), plugin('page')];
    const held = plugins.map(() => deferred<Record<string, unknown>>());
    const calls: string[] = [];
    const io = {
      page: { id: 'page', section: null }, index: async () => plugins.map((p) => p.manifest),
      url: (id: string) => id,
      load: (id: string) => { calls.push(id); return held[plugins.findIndex((p) => p.manifest.id === id)]!.promise; },
      report: () => { throw new Error('Unexpected refusal'); },
    };
    const loading = loadShared(io, {}, [], null);
    await settle();
    expect(calls).toEqual(['page', 'background']);
    held[1]!.resolve({ default: plugins[1]!.descriptor });
    held[0]!.resolve({ default: plugins[0]!.descriptor });
    expect((await loading).map((p) => p.manifest.id)).toEqual(['background', 'page']);
  });

  it('starts first-pane contributions first while retaining declared registration order', async () => {
    const shared = [
      plugin('background'),
      plugin('posting', { slots: { chatFooter: [{ id: 'compose' }] } }),
      plugin('inbox', { slots: { phoneSections: [{ id: 'feed', after: 'archive' }] }, adopts: { phoneSections: { oldFeed: 'feed' } } }),
      plugin('page'),
    ];
    const held = new Map(shared.map((p) => [p.manifest.id, deferred<Record<string, unknown>>()]));
    for (const section of ['inbox.feed', 'oldFeed']) {
      const calls: string[] = [];
      const io = {
        page: { id: 'page', section }, url: (id: string) => id,
        stylesheet: async () => () => undefined,
        load: (id: string) => { calls.push(id); return held.get(id)!.promise; },
        report: () => { throw new Error('Unexpected refusal'); },
      };
      const loading = loadRenderers(io, shared, {});
      await settle();
      expect(calls).toEqual(['posting', 'inbox', 'page', 'background']);
      for (const p of shared.slice().reverse()) {
        const contributions = p.manifest.id === 'posting' ? { chatFooter: { compose: {} } }
          : p.manifest.id === 'inbox' ? { phoneSections: { feed: {} } } : {};
        held.get(p.manifest.id)!.resolve({ default: { plugin: p.descriptor, contributions } });
      }
      expect((await loading).map((p) => p.plugin.manifest.id)).toEqual(shared.map((p) => p.manifest.id));
    }
  });

  it('waits for each plugin’s styles without blocking independent renderer imports', async () => {
    const styled = plugin('styled');
    styled.manifest.browser.styles = ['look.css'];
    const independent = plugin('independent');
    const css = deferred<() => void>();
    const calls: string[] = [];
    const io = {
      url: (id: string) => id, stylesheet: () => css.promise,
      load: async (id: string) => {
        calls.push(id);
        return { default: { plugin: id === 'styled' ? styled.descriptor : independent.descriptor, contributions: {} } };
      },
      report: () => { throw new Error('Unexpected refusal'); },
    };
    const loading = loadRenderers(io, [styled, independent], {});
    await settle();
    expect(calls).toEqual(['independent']);
    css.resolve(() => undefined);
    expect((await loading).map((p) => p.plugin.manifest.id)).toEqual(['styled', 'independent']);
    expect(calls).toEqual(['independent', 'styled']);
  });
});
