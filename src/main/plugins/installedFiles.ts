// Serves startup-accepted browser files through chattypop-installed or Companion /installed; pages/public assets use ctx.pages.
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { INSTALLED_CONTENT_TYPES, INSTALLED_INDEX, INSTALLED_PHONE_PATH } from '@shared/installedBrowser';
import { INSTALLED_PAGE_PUBLIC_DIR, INSTALLED_PLATFORM_DIRS, type InstalledPage, type InstalledPlugin } from '@shared/installedPlugins';
import { assetReply, contentTag, REVALIDATE_ASSET } from './assetCache';
import { browserVersion, unversionedFile, versionedManifest } from './browserVersion';

const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
/** The folder of a built plugin that windows and the phone may read; node/ and the manifest's siblings stay private. */
const BROWSER_DIR = INSTALLED_PLATFORM_DIRS.browser;
/** A page's public files, by the URL path the phone requests them at. */
const PUBLIC_PREFIX = `${BROWSER_DIR}/${INSTALLED_PAGE_PUBLIC_DIR}`;
/** An installed page's HTML, read by main only: /installed/ never serves it. */
const PAGE_TYPES: Readonly<Record<string, string>> = { '.html': 'text/html; charset=utf-8' };
const HEADERS = { 'access-control-allow-origin': '*', 'cache-control': REVALIDATE_ASSET };
const HTTP_TEMPORARY_REDIRECT = 307;
const PUBLIC_VERSION_QUERY = 'cp-v';
/** Service workers keep their root URL and scope, and must check for updates. */
const MUTABLE_PUBLIC_FILE = /\.(?:js|json|webmanifest)$/;

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
  publicFile(path: string, search?: string): Promise<Response | null>;
}

const status = (code: number): Response => new Response(null, { status: code, headers: HEADERS });

/** Whether `file` is inside `root` (not `root` itself). */
const inside = (root: string, file: string): boolean => file.startsWith(root + sep);

/** Resolves manifest-relative files only under browser with allowed types. Returns status for disallowed or missing paths. */
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
async function reply(found: { file: string; type: string } | number, immutable = false, expectedTag?: string): Promise<Response> {
  if (typeof found === 'number') return status(found);
  const body = await readFile(found.file);
  if (immutable && contentTag(body) !== expectedTag) return status(HTTP_NOT_FOUND);
  return assetReply(body, found.type, immutable, HEADERS);
}

/** Serves the index of `accepted` (their manifests, in load order), their browser files, and their pages. */
export function installedFiles(accepted: readonly InstalledPlugin[]): InstalledFiles {
  const byId = new Map(accepted.map((p) => [p.manifest.id, p]));
  const pending = new Map<string, ReturnType<typeof browserVersion>>();
  const version = (id: string): ReturnType<typeof browserVersion> => {
    if (!pending.has(id)) pending.set(id, browserVersion(resolve(byId.get(id)!.dir, BROWSER_DIR)));
    return pending.get(id)!;
  };
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
        if (path.replace(/^\/+/, '')) return status(HTTP_NOT_FOUND);
        const manifests = await Promise.all(accepted.map(async (p) => versionedManifest(p.manifest, (await version(p.manifest.id)).hash)));
        return assetReply(JSON.stringify(manifests), INSTALLED_CONTENT_TYPES['.json']!, false, HEADERS);
      }
      const plugin = byId.get(name);
      if (!plugin) return status(HTTP_NOT_FOUND);
      const current = await version(name);
      const target = unversionedFile(path, current.hash);
      return target ? reply(await browserFile(plugin, target.path), target.immutable, current.tags.get(target.path)) : status(HTTP_NOT_FOUND);
    },
    async page(path) {
      const plugin = pages.get(path);
      const page = plugin?.manifest.browser.page;
      if (!plugin || !page) return null;
      const found = await browserFile(plugin, page.html, PAGE_TYPES);
      if (typeof found === 'number') return status(found);
      const current = await version(plugin.manifest.id);
      return { id: plugin.manifest.id, html: await readFile(found.file, 'utf8'), page: versionedManifest(plugin.manifest, current.hash).browser.page! };
    },
    async publicFile(path, search = '') {
      const found = publicFiles.get(path);
      if (!found) return null;
      if (MUTABLE_PUBLIC_FILE.test(found.file)) return reply(await browserFile(found.plugin, found.file));
      const current = await version(found.plugin.manifest.id);
      const query = new URLSearchParams(search);
      const requestedVersion = query.get(PUBLIC_VERSION_QUERY);
      if (requestedVersion !== null) {
        return requestedVersion === current.hash
          ? reply(await browserFile(found.plugin, found.file), true, current.tags.get(found.file)) : status(HTTP_NOT_FOUND);
      }
      query.set(PUBLIC_VERSION_QUERY, current.hash);
      return new Response(null, { status: HTTP_TEMPORARY_REDIRECT, headers: {
        ...HEADERS, location: `${path}?${query}`,
      } });
    },
  };
}
