// A fake GitHub (routes by URL, every request recorded), a minimal .tar.gz writer, and a built plugin fixture.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { PLUGIN_SDK_VERSION } from '@shared/installedPlugins';
import type { MarketplaceIndex } from '@shared/marketplace';
import type { FetchFn } from '../src/main/marketplace/github';
import { Marketplaces, type BuildPlugin, type SecretStore } from '../src/main/marketplace/marketplaces';
import { tempDir } from './helpers';

export const REPO = 'owner/market';
export const API = 'https://api.github.com';
/** Where a tokenless install reads the index (main's) and downloads release assets. */
export const RAW_INDEX = `https://raw.githubusercontent.com/${REPO}/main/marketplace.json`;
export const DOWNLOAD = `https://github.com/${REPO}/releases/download`;
export const TOKEN = 'github_pat_secret123';
const TAR_BLOCK = 512;

/** One tar entry: a file (content), a folder, or a raw type flag with a link target. */
export interface TarEntry {
  path: string;
  content?: string;
  type?: '0' | '1' | '2' | '5';
  link?: string;
}

function header(e: TarEntry, size: number): Buffer {
  const h = Buffer.alloc(TAR_BLOCK);
  const put = (text: string, at: number, len: number): void => void h.write(text, at, len, 'utf8');
  const octal = (n: number, len: number): string => n.toString(8).padStart(len - 1, '0') + '\0';
  put(e.path, 0, 100);
  put(octal(e.type === '5' ? 0o755 : 0o644, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(0, 12), 136, 12);
  put(' '.repeat(8), 148, 8);
  put(e.type ?? (e.content === undefined ? '5' : '0'), 156, 1);
  if (e.link) put(e.link, 157, 100);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  const sum = h.reduce((a, b) => a + b, 0);
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

/** A gzipped ustar archive of `entries`, written without touching the file system. */
export function tarGz(entries: TarEntry[]): Buffer {
  const parts = entries.flatMap((e) => {
    const body = Buffer.from(e.content ?? '');
    const pad = Buffer.alloc((TAR_BLOCK - (body.length % TAR_BLOCK)) % TAR_BLOCK);
    return [header(e, body.length), body, pad];
  });
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(TAR_BLOCK * 2)]));
}

export const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** A built plugin's files, relative to its folder. */
export function builtFiles(id = 'demo', version = '1.0.0', sdk = PLUGIN_SDK_VERSION): Record<string, string> {
  const manifest = { format: 1, id, name: `Plugin ${id}`, version, description: '', sdk, node: { shared: 'node/shared.js' }, browser: { shared: 'browser/shared.js', styles: [] }, hostImports: {} };
  return { 'plugin.json': JSON.stringify(manifest), 'node/shared.js': 'export default {};', 'browser/shared.js': 'export default {};' };
}

export const filesToTar = (files: Record<string, string>, prefix = ''): TarEntry[] => Object.entries(files).map(([path, content]) => ({ path: prefix + path, content }));

export function writeFiles(dir: string, files: Record<string, string>): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

export interface Call {
  url: string;
  headers: Record<string, string>;
  redirect: RequestInit['redirect'];
}

type Route = () => Response | Promise<Response>;
/** GitHub's hosts serving a public repo's files and release assets without the API. */
const PUBLIC_HOSTS = new Set(['raw.githubusercontent.com', 'github.com']);

/** Routes by exact URL; unknown URLs answer 404. Every call is recorded with its headers. */
export class FakeGitHub {
  readonly calls: Call[] = [];
  readonly routes = new Map<string, Route>();
  /** When set, requests without this bearer token answer 404, as GitHub does for a private repo. */
  privateToken: string | null = null;

  fetch: FetchFn = async (url, init) => {
    const headers = init.headers as Record<string, string>;
    this.calls.push({ url, headers, redirect: init.redirect });
    const onApi = new URL(url).host === 'api.github.com';
    if (onApi && this.privateToken && headers['authorization'] !== `Bearer ${this.privateToken}`) return new Response('{}', { status: 404 });
    // A private repo's files and assets aren't served outside the API.
    if (!onApi && this.privateToken && PUBLIC_HOSTS.has(new URL(url).host)) return new Response('{}', { status: 404 });
    return (await this.routes.get(url)?.()) ?? new Response('{}', { status: 404 });
  };

  json(url: string, body: unknown): void {
    this.routes.set(url, () => new Response(JSON.stringify(body)));
  }

  /** `url` redirects to a download host serving `body`. */
  redirected(url: string, body: Buffer): void {
    const target = `https://objects.example-cdn.com/${this.routes.size}`;
    this.routes.set(url, () => new Response(null, { status: 302, headers: { location: target } }));
    this.routes.set(target, () => new Response(body));
  }
}

export interface Fixture {
  gh: FakeGitHub;
  profile: string;
  secrets: Map<string, string>;
  asset: Buffer;
  index: MarketplaceIndex;
  /** Serves `index` as the listing, through the API (with a token) and the raw host (without). */
  listing(index: MarketplaceIndex | object): void;
  /** `builtIn`: the repos listed without adding (none by default, so tests add REPO themselves). */
  make(build?: BuildPlugin | null, builtIn?: readonly string[]): Marketplaces;
}

export const ASSET_ID = 7;
export const COMMIT = 'a'.repeat(40);

/** A marketplace listing plugin `demo` 1.0.0 (a release) with its source at plugins/demo on main. */
export function fixture(asset = tarGz(filesToTar(builtFiles())), sdk = PLUGIN_SDK_VERSION): Fixture {
  const gh = new FakeGitHub();
  const index: MarketplaceIndex = {
    format: 1,
    plugins: [{ id: 'demo', name: 'Demo', description: '', releases: [{ version: '1.0.0', tag: 'demo-v1.0.0', asset: 'demo.tar.gz', sha256: sha(asset), sdk }], source: { path: 'plugins/demo', branch: 'main' } }],
  };
  gh.json(`${API}/repos/${REPO}`, { default_branch: 'main' });
  const listing = (i: MarketplaceIndex | object): void => {
    gh.json(`${API}/repos/${REPO}/contents/marketplace.json`, i);
    gh.json(RAW_INDEX, i);
  };
  listing(index);
  gh.json(`${API}/repos/${REPO}/releases/tags/demo-v1.0.0`, { assets: [{ id: ASSET_ID, name: 'demo.tar.gz' }] });
  gh.redirected(`${API}/repos/${REPO}/releases/assets/${ASSET_ID}`, asset);
  gh.redirected(`${DOWNLOAD}/demo-v1.0.0/demo.tar.gz`, asset);
  gh.json(`${API}/repos/${REPO}/commits/main`, { sha: COMMIT });
  gh.redirected(`${API}/repos/${REPO}/tarball/${COMMIT}`, tarGz([{ path: 'owner-market-aaaaaaa/' }, ...filesToTar({ 'plugins/demo/src.ts': 'x', 'README.md': 'r' }, 'owner-market-aaaaaaa/')]));
  const profile = tempDir();
  const secrets = new Map<string, string>();
  const store: SecretStore = { read: (f) => secrets.get(f) ?? null, write: (f, v) => void secrets.set(f, v), delete: (f) => void secrets.delete(f) };
  return { gh, profile, secrets, asset, index, listing, make: (build = null, builtIn = []) => new Marketplaces({ profileDir: profile, secrets: store, fetch: gh.fetch, build, builtIn, leftoverFailed: () => undefined, now: () => 1 }) };
}
