import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { INSTALLED_INDEX } from '@shared/installedBrowser';
import { INSTALLED_FORMAT, PLUGIN_SDK_VERSION, parseInstalledManifest, type InstalledManifest, type InstalledPlugin } from '@shared/installedPlugins';
import { installedFiles } from '../src/main/plugins/installedFiles';
import { rendererPages } from '../src/main/plugins/pages';
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
    const updated = installedFiles([accepted]);
    const [next] = await (await updated.response(INSTALLED_INDEX, '')).json() as InstalledManifest[];
    if (!next) throw new Error('Missing updated fixture manifest.');
    expect(next.browser.shared).not.toBe(manifest.browser.shared);
    expect((await updated.response('probe', chunkPath)).status).toBe(404);
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
