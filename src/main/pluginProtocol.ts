import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { protocol, type CustomScheme } from 'electron';
import { INSTALLED_SCHEME } from '@shared/installedBrowser';
import { PLUGIN_SCHEME } from '@shared/plugins';
import type { CoreClient } from './coreClient';
import type { InstalledFiles } from './plugins/installedFiles';

/** Same privileges as the app's own pages: module scripts, fetch and CSS load from it. */
export const PLUGIN_SCHEME_PRIVILEGES: CustomScheme = { scheme: PLUGIN_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } };
/** Installed plugins' browser files (docs/plugin-architecture.md §16), with the same privileges. */
export const INSTALLED_SCHEME_PRIVILEGES: CustomScheme = { scheme: INSTALLED_SCHEME, privileges: { ...PLUGIN_SCHEME_PRIVILEGES.privileges } };

/** chattypop-installed://<index or plugin id>/<path>: the accepted plugins' index and browser files. */
export function handleInstalledScheme(files: InstalledFiles): void {
  protocol.handle(INSTALLED_SCHEME, (req) => {
    const url = new URL(req.url);
    return files.response(url.hostname, url.pathname);
  });
}

/** Types a plugin's renderer files may have; anything else is refused. */
const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const status = (code: number): Response => new Response(null, { status: code });

/** chattypop-plugin://<plugin id>/<path>: files from an active plugin's own folder only. */
export function handlePluginScheme(core: CoreClient): void {
  protocol.handle(PLUGIN_SCHEME, async (req) => {
    const url = new URL(req.url);
    const plugin = (await core.call('plugins')).find((p) => p.id === url.hostname && p.status === 'active');
    if (!plugin) return status(404);
    const root = resolve(plugin.dir);
    const file = resolve(root, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
    const type = CONTENT_TYPES[extname(file).toLowerCase()];
    if (!file.startsWith(root + sep) || !type) return status(403);
    if (!existsSync(file)) return status(404);
    // Module scripts are fetched with CORS (the renderer's origin differs from this scheme's).
    return new Response(new Uint8Array(await readFile(file)), { headers: { 'content-type': type, 'access-control-allow-origin': '*' } });
  });
}
