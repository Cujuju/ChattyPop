import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { INSTALLED_INDEX } from '@shared/installedBrowser';
import { INSTALLED_FORMAT, PLUGIN_SDK_VERSION, parseInstalledManifest, type InstalledManifest, type InstalledPlugin } from '@shared/installedPlugins';
import { installedFiles } from '../src/main/plugins/installedFiles';
import { rendererPages } from '../src/main/plugins/pages';
import * as browserVersions from '../src/main/plugins/browserVersion';
import { tempDir } from './helpers';

function plugin(): InstalledPlugin {
  const dir = tempDir();
  mkdirSync(join(dir, 'browser/chunks'), { recursive: true });
  writeFileSync(join(dir, 'browser/shared.js'), "export { value } from './chunks/value.js';");
  writeFileSync(join(dir, 'browser/chunks/value.js'), 'export const value = 1;');
  return { dir, source: null, manifest: parseInstalledManifest({ format: INSTALLED_FORMAT, id: 'probe', name: 'Probe', version: '1.0.0',
    description: '', sdk: PLUGIN_SDK_VERSION, node: { shared: 'node/shared.js' }, browser: { shared: 'browser/shared.js', styles: [] }, hostImports: {} }) };
}

describe('phone asset cache contracts', () => {
  it('versions manifests and relative chunks by content, including same-version local rebuilds', async () => {
    const accepted = plugin();
    const files = installedFiles([accepted]);
    const index = await files.response(INSTALLED_INDEX, '');
    expect(index.headers.get('cache-control')).toBe('private, no-cache');
    expect(index.headers.get('etag')).toMatch(/^"[a-f0-9]{64}"$/);
    const [manifest] = await index.json() as InstalledManifest[];
    if (!manifest) throw new Error('Missing fixture manifest.');
    expect(parseInstalledManifest(manifest).browser.shared).toMatch(/^browser\/cp-[a-f0-9]{64}\/shared.js$/);
    const asset = await files.response('probe', manifest.browser.shared);
    expect(asset.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    const chunkPath = manifest.browser.shared.replace('shared.js', 'chunks/value.js');
    expect(await (await files.response('probe', chunkPath)).text()).toContain('value = 1');
    writeFileSync(join(accepted.dir, 'browser/chunks/value.js'), 'export const value = 2;');
    expect((await files.response('probe', chunkPath)).status).toBe(404);
    const [next] = await (await files.response(INSTALLED_INDEX, '')).json() as InstalledManifest[];
    if (!next) throw new Error('Missing updated fixture manifest.');
    expect(next.browser.shared).not.toBe(manifest.browser.shared);
    expect((await files.response('probe', chunkPath)).status).toBe(404);
    const nextChunk = next.browser.shared.replace('shared.js', 'chunks/value.js');
    expect(await (await files.response('probe', nextChunk)).text()).toContain('value = 2');
  });

  it('refreshes page URLs after a versioned public asset changes', async () => {
    const accepted = plugin();
    mkdirSync(join(accepted.dir, 'browser/public'));
    writeFileSync(join(accepted.dir, 'browser/public/icon.png'), 'old icon');
    writeFileSync(join(accepted.dir, 'browser/page.html'), '<html><head></head></html>');
    accepted.manifest.browser.page = { html: 'browser/page.html', entry: 'browser/shared.js', styles: [], public: ['browser/public/icon.png'] };
    const files = installedFiles([accepted]);
    const firstPage = await files.page('/probe.html');
    if (!firstPage || firstPage instanceof Response) throw new Error('Missing fixture page.');
    const first = await files.publicFile('/icon.png');
    const firstUrl = new URL(first!.headers.get('location')!, 'http://probe');
    expect(await (await files.publicFile(firstUrl.pathname, firstUrl.search))!.text()).toBe('old icon');
    writeFileSync(join(accepted.dir, 'browser/public/icon.png'), 'new icon');
    expect((await files.publicFile(firstUrl.pathname, firstUrl.search))!.status).toBe(404);
    const nextPage = await files.page('/probe.html');
    if (!nextPage || nextPage instanceof Response) throw new Error('Missing updated fixture page.');
    expect(nextPage.page.entry).not.toBe(firstPage.page.entry);
    const next = await files.publicFile('/icon.png');
    const nextUrl = new URL(next!.headers.get('location')!, 'http://probe');
    expect(nextUrl.search).not.toBe(firstUrl.search);
    expect(await (await files.publicFile(nextUrl.pathname, nextUrl.search))!.text()).toBe('new icon');
    expect((await files.publicFile(firstUrl.pathname, firstUrl.search))!.status).toBe(404);
  });

  it('starts hashing every accepted plugin before a request and reuses the warm promises', async () => {
    const accepted = [plugin(), plugin()];
    accepted[1]!.manifest.id = 'other';
    const hashing = vi.spyOn(browserVersions, 'browserVersion');
    try {
      const files = installedFiles(accepted);
      expect(hashing.mock.calls.map(([root]) => root)).toEqual(accepted.map((p) => join(p.dir, 'browser')));
      await (await files.response(INSTALLED_INDEX, '')).text();
      expect(hashing).toHaveBeenCalledTimes(accepted.length);
    } finally { hashing.mockRestore(); }
  });

  it('keeps warm hashing errors for requests that use the failed plugin', async () => {
    const failure = new Error('Browser hashing failed.');
    const hashing = vi.spyOn(browserVersions, 'browserVersion').mockRejectedValue(failure);
    try {
      const files = installedFiles([plugin()]);
      await expect(files.response(INSTALLED_INDEX, '')).rejects.toBe(failure);
      await expect(files.response('probe', 'browser/shared.js')).rejects.toBe(failure);
      expect(hashing).toHaveBeenCalledTimes(1);
    } finally { hashing.mockRestore(); }
  });

  it('validates built files, caching hashed assets and revalidating mutable entry points', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'assets'));
    for (const file of ['index.html', 'sw.js', 'assets/page-abcdefgh.js']) writeFileSync(join(dir, file), 'body');
    const pages = rendererPages(dir, null);
    for (const path of ['/index.html', '/sw.js', '/assets/page-abcdefgh.js']) {
      const response = await pages.response(path);
      expect(response.headers.get('etag')).toMatch(/^W\/"/);
      expect(response.headers.get('last-modified')).toBeTruthy();
      expect(response.headers.get('cache-control')).toBe(path.startsWith('/assets/') ? 'private, max-age=31536000, immutable' : 'private, no-cache');
      await response.text();
    }
  });

  it('preserves Vite freshness and query parameters', async () => {
    const fetcher = vi.fn(async (_url: URL) => new Response('vite', { headers: { 'cache-control': 'no-cache', etag: 'vite-tag' } }));
    vi.stubGlobal('fetch', fetcher);
    try {
      const response = await rendererPages('', 'http://localhost:5173').response('/@vite/client', '?t=123');
      expect(fetcher.mock.calls[0]?.[0]?.href).toBe('http://localhost:5173/@vite/client?t=123');
      expect(response.headers.get('cache-control')).toBe('no-cache');
      expect(response.headers.get('etag')).toBe('vite-tag');
    } finally { vi.unstubAllGlobals(); }
  });
});
