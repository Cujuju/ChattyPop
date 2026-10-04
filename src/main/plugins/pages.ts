// The renderer's pages as HTTP replies (main ctx.pages): the build folder, or Vite's dev server in `pnpm dev`, for a
// plugin that serves its page outside the app; and installed plugins' pages, files and pages' public files.
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';
import { INSTALLED_PAGE_ENTRY_META, INSTALLED_PAGE_SHELL, INSTALLED_PHONE_PATH } from '@shared/installedBrowser';
import type { InstalledFiles, InstalledPageReply } from './installedFiles';

const HTTP_NOT_FOUND = 404;
const HTTP_INTERNAL_ERROR = 500;
const HTTP_BAD_GATEWAY = 502;

/** MIME types of what the renderer build emits. */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

/** A file of the renderer build, or of its dev server, as a reply. */
export interface Pages {
  /** The file at `path` (`search` reaches the dev server only); 404 when missing or outside the build, 502 when the dev server is down. */
  response(path: string, search?: string): Promise<Response>;
}

/** File under `root` for a URL path; null when it would leave `root` or is malformed. */
export function staticFile(root: string, urlPath: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (path.includes('\0')) return null;
  const file = normalize(join(root, path));
  return file.startsWith(root.endsWith(sep) ? root : root + sep) ? file : null;
}

/**
 * `path` and `search` on the dev server's own origin: set as the URL's parts, never resolved against it, so a path like
 * `//host/x` can't name another server. null for a path that isn't one.
 */
function devTarget(devUrl: string, path: string, search: string): URL | null {
  if (!path.startsWith('/')) return null;
  const url = new URL(devUrl);
  url.pathname = path;
  url.search = search;
  return url;
}

/** The page shell's head: the tags of the host's page bootstrap, as built (or served by the dev server). */
const SHELL_HEAD = /<head>([\s\S]*?)<\/head>/;
/** Where an installed page's HTML takes the host's tags: the end of its head, after its own metas (its CSP first). */
const HEAD_END = /<\/head>/i;

/** The shell's head from the build at `dir` or the dev server; null when it can't be read. */
async function shellHead(dir: string, devUrl: string | null): Promise<string | null> {
  const target = devUrl ? devTarget(devUrl, `/${INSTALLED_PAGE_SHELL}`, '') : null;
  const html = target
    ? await fetch(target, { redirect: 'error' }).then((r) => (r.ok ? r.text() : null), () => null)
    : await readFile(join(dir, INSTALLED_PAGE_SHELL), 'utf8').catch(() => null);
  return (html && SHELL_HEAD.exec(html)?.[1]?.trim()) || null;
}

/**
 * An installed page as served: its HTML with the shell's head, stylesheets and the entry meta, imported by the
 * bootstrap once host modules publish. Paths are manifest-checked: no quoting.
 */
function installedPage({ id, html, page }: InstalledPageReply, head: string): string | null {
  if (!HEAD_END.test(html)) return null;
  const url = (file: string): string => `${INSTALLED_PHONE_PATH}${id}/${file}`;
  const tags = [head, ...page.styles.map((s) => `<link rel="stylesheet" href="${url(s)}">`), `<meta name="${INSTALLED_PAGE_ENTRY_META}" content="${url(page.entry)}">`];
  return html.replace(HEAD_END, (end) => `${tags.join('\n')}\n${end}`);
}

const htmlReply = (html: string): Response => {
  const body = new TextEncoder().encode(html);
  return new Response(body, { headers: { 'content-type': MIME['.html']!, 'content-length': String(body.byteLength) } });
};

/**
 * Pages for the renderer build at `dir`, or its dev server at `devUrl`, bound to this PC. `installed` serves
 * INSTALLED_PHONE_PATH and installed-page (`/<id>.html`) paths first, in development too.
 */
export function rendererPages(dir: string, devUrl: string | null, installed: InstalledFiles | null = null): Pages {
  return {
    async response(path, search = '') {
      if (path.startsWith(INSTALLED_PHONE_PATH)) {
        if (!installed) return new Response(null, { status: HTTP_NOT_FOUND });
        const rest = path.slice(INSTALLED_PHONE_PATH.length);
        const slash = rest.indexOf('/');
        return slash < 0 ? installed.response(rest, '') : installed.response(rest.slice(0, slash), rest.slice(slash));
      }
      const page = await installed?.page(path);
      if (page instanceof Response) return page;
      if (page) {
        const head = await shellHead(dir, devUrl);
        if (!head) return new Response(null, { status: devUrl ? HTTP_BAD_GATEWAY : HTTP_INTERNAL_ERROR });
        const html = installedPage(page, head);
        return html === null ? new Response(null, { status: HTTP_INTERNAL_ERROR }) : htmlReply(html);
      }
      const publicFile = await installed?.publicFile(path);
      if (publicFile) return publicFile;
      if (devUrl) {
        const target = devTarget(devUrl, path, search);
        if (!target) return new Response(null, { status: HTTP_NOT_FOUND });
        // No redirects: one could leave the dev server. Hot reload doesn't reach a page served elsewhere; reload it.
        return (await fetch(target, { redirect: 'error' }).catch(() => null)) ?? new Response(null, { status: HTTP_BAD_GATEWAY });
      }
      const file = staticFile(dir, path);
      const info = file ? await stat(file).catch(() => null) : null;
      if (!file || !info?.isFile()) return new Response(null, { status: HTTP_NOT_FOUND });
      const body = Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>;
      return new Response(body, { headers: { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'content-length': String(info.size) } });
    },
  };
}
