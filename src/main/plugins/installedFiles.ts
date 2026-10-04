// Installed plugins' browser files as replies (docs/plugin-architecture.md §16, Start): the index of the plugins main
// accepted at start, and files under each one's browser/ folder. Windows read them through chattypop-installed:, the
// phone through the Companion's /installed/ (ctx.pages), which also serves their pages and pages' public files.
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { INSTALLED_CONTENT_TYPES, INSTALLED_INDEX } from '@shared/installedBrowser';
import { INSTALLED_PAGE_PUBLIC_DIR, INSTALLED_PLATFORM_DIRS, type InstalledPage, type InstalledPlugin } from '@shared/installedPlugins';

const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
/** The folder of a built plugin that windows and the phone may read; node/ and the manifest's siblings stay private. */
const BROWSER_DIR = INSTALLED_PLATFORM_DIRS.browser;
/** A page's public files, by the URL path the phone requests them at. */
const PUBLIC_PREFIX = `${BROWSER_DIR}/${INSTALLED_PAGE_PUBLIC_DIR}`;
/** An installed page's HTML, read by main only: /installed/ never serves it. */
const PAGE_TYPES: Readonly<Record<string, string>> = { '.html': 'text/html; charset=utf-8' };
/**
 * Every reply. Module scripts are fetched with CORS (a window's origin differs from the scheme's). Not cached: an
 * update applies at the next start, and a page loaded after it must get the new files.
 */
const HEADERS = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };

/** An accepted plugin's page as main serves it: its id, its HTML without the entry, and its manifest entry. */
export interface InstalledPageReply {
  id: string;
  html: string;
  page: InstalledPage;
}

/** Replies for installed plugins' browser files. */
export interface InstalledFiles {
  /** `name` is INSTALLED_INDEX or a plugin id; `path` a URL path from that plugin's folder, as its manifest names files. */
  response(name: string, path: string): Promise<Response>;
  /** The page at `/<id>.html`, or a status when its HTML is missing; null when no accepted plugin has a page there. */
  page(path: string): Promise<InstalledPageReply | Response | null>;
  /** A page's public file at its URL path (the first plugin in load order that has it); null when none has. */
  publicFile(path: string): Promise<Response | null>;
}

const status = (code: number): Response => new Response(null, { status: code, headers: HEADERS });

/** Whether `file` is inside `root` (not `root` itself). */
const inside = (root: string, file: string): boolean => file.startsWith(root + sep);

/**
 * The file a URL path names, relative to `plugin`'s folder as its manifest's paths are; a status when it isn't under the
 * browser/ folder, isn't one of `types` or is missing.
 */
async function browserFile(plugin: InstalledPlugin, urlPath: string, types: Readonly<Record<string, string>> = INSTALLED_CONTENT_TYPES): Promise<{ file: string; type: string } | number> {
  let path: string;
  try {
    path = decodeURIComponent(urlPath);
  } catch {
    return HTTP_NOT_FOUND;
  }
  if (path.includes('\0')) return HTTP_NOT_FOUND;
  const root = resolve(plugin.dir, BROWSER_DIR);
  const file = resolve(plugin.dir, path.replace(/^[/\\]+/, ''));
  const type = types[extname(file).toLowerCase()];
  if (!inside(root, file) || !type) return HTTP_FORBIDDEN;
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return HTTP_NOT_FOUND;
  // A link inside the folder can't lead out of it (installs refuse links; a local build folder may have one).
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file)]);
  return inside(realRoot, realFile) ? { file: realFile, type } : HTTP_FORBIDDEN;
}

/** `found` as a reply: the file with its type, or the status. */
async function reply(found: { file: string; type: string } | number): Promise<Response> {
  if (typeof found === 'number') return status(found);
  return new Response(new Uint8Array(await readFile(found.file)), { headers: { ...HEADERS, 'content-type': found.type } });
}

/** Serves the index of `accepted` (their manifests, in load order), their browser files, and their pages. */
export function installedFiles(accepted: readonly InstalledPlugin[]): InstalledFiles {
  const byId = new Map(accepted.map((p) => [p.manifest.id, p]));
  const index = JSON.stringify(accepted.map((p) => p.manifest));
  const pages = new Map<string, InstalledPlugin>(accepted.flatMap((p) => (p.manifest.browser.page ? [[`/${p.manifest.id}.html`, p]] : [])));
  const publicFiles = new Map<string, { plugin: InstalledPlugin; file: string }>();
  for (const plugin of accepted) {
    for (const file of plugin.manifest.browser.page?.public ?? []) {
      const path = file.slice(PUBLIC_PREFIX.length);
      if (!publicFiles.has(path)) publicFiles.set(path, { plugin, file });
    }
  }
  return {
    async response(name, path) {
      if (name === INSTALLED_INDEX) {
        return path.replace(/^\/+/, '') ? status(HTTP_NOT_FOUND) : new Response(index, { headers: { ...HEADERS, 'content-type': INSTALLED_CONTENT_TYPES['.json']! } });
      }
      const plugin = byId.get(name);
      return plugin ? reply(await browserFile(plugin, path)) : status(HTTP_NOT_FOUND);
    },
    async page(path) {
      const plugin = pages.get(path);
      const page = plugin?.manifest.browser.page;
      if (!plugin || !page) return null;
      const found = await browserFile(plugin, page.html, PAGE_TYPES);
      if (typeof found === 'number') return status(found);
      return { id: plugin.manifest.id, html: await readFile(found.file, 'utf8'), page };
    },
    async publicFile(path) {
      const found = publicFiles.get(path);
      return found ? reply(await browserFile(found.plugin, found.file)) : null;
    },
  };
}
