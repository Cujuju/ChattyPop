import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { INSTALLED_CONTENT_TYPES } from '@shared/installedBrowser';
import type { InstalledManifest } from '@shared/installedPlugins';
import { contentTag } from './assetCache';

const VERSION_PREFIX = 'cp-';
const VERSION_PATH = /^\/?browser\/cp-([a-f0-9]{64})\/(.*)$/;

export interface BrowserVersion {
  hash: string;
  tags: ReadonlyMap<string, string>;
}

/** Hashes allowed browser files in path order, including chunks and public assets. Links outside the root are excluded. */
export async function browserVersion(root: string): Promise<BrowserVersion> {
  const hash = createHash('sha256');
  const tags = new Map<string, string>();
  const realRoot = await realpath(root);
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!INSTALLED_CONTENT_TYPES[extname(file)] && extname(file) !== '.html') continue;
      const realFile = await realpath(file);
      if (!realFile.startsWith(realRoot + sep)) continue;
      const path = `browser/${relative(root, file).split(sep).join('/')}`;
      const body = await readFile(realFile);
      const tag = contentTag(body);
      tags.set(path, tag);
      hash.update(JSON.stringify([path, tag]));
    }
  }
  await walk(root);
  return { hash: hash.digest('hex'), tags };
}

export const versionedFile = (file: string, hash: string): string => file.replace(/^browser\//, `browser/${VERSION_PREFIX}${hash}/`);

export function unversionedFile(path: string, hash: string): { path: string; immutable: boolean } | null {
  const version = VERSION_PATH.exec(path);
  if (!version) return { path, immutable: false };
  return version[1] === hash ? { path: `browser/${version[2]}`, immutable: true } : null;
}

/** Keeps the manifest contract unchanged while supplying versioned loader entry paths. */
export function versionedManifest(manifest: InstalledManifest, hash: string): InstalledManifest {
  const file = (path: string): string => versionedFile(path, hash);
  const browser = manifest.browser;
  return { ...manifest, browser: {
    ...browser, shared: file(browser.shared),
    ...(browser.renderer ? { renderer: file(browser.renderer) } : {}),
    styles: browser.styles.map(file),
    ...(browser.page ? { page: { ...browser.page, entry: file(browser.page.entry), styles: browser.page.styles.map(file) } } : {}),
  } };
}
