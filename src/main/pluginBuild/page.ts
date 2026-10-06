// A plugin's installed-build page (docs/plugin-architecture.md §16, Pages): page/index.html minus its entry script, the
// entry built with the browser sides, its imported stylesheets, and page/public/ copied. Main serves it.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Rollup } from 'vite';
import { INSTALLED_PAGE_PUBLIC_DIR, INSTALLED_PLATFORM_DIRS, type InstalledPage } from '../../shared/installedPlugins';

/** The page's folder in a plugin folder, its HTML, and its public files' folder. */
export const PAGE_DIR = 'page';
const PAGE_HTML = 'index.html';
const PAGE_PUBLIC = 'public';
/** The entry's build input name, so `page.js` in browser/; the HTML beside it. */
export const PAGE_INPUT = 'page';
const BUILT_HTML = 'page.html';

/** The page's one script: a module with a relative src, which the build takes out and builds as the entry. */
const ENTRY_SCRIPT = /[ \t]*<script type="module" src="(\.\/[^"]+)"><\/script>[ \t]*\r?\n?/;
const ANY_SCRIPT = /<script\b/gi;
/** Relative HTML URLs resolve against page URLs rather than plugin folders. */
const RELATIVE_URL = /\s(?:src|href)="(\.[^"]*)"/i;
const HEAD_END = /<\/head>/i;

/** A page from source: its entry module and its HTML without the entry script. */
export interface SourcePage {
  dir: string;
  entry: string;
  html: string;
}

/** The plugin folder's page, or null when it has none. Throws why its HTML can't be served as an installed page. */
export function readPage(pluginDir: string): SourcePage | null {
  const dir = join(pluginDir, PAGE_DIR);
  if (!existsSync(dir)) return null;
  const where = `${PAGE_DIR}/${PAGE_HTML}`;
  const file = join(dir, PAGE_HTML);
  if (!existsSync(file)) throw new Error(`${pluginDir} has a ${PAGE_DIR}/ folder without ${where}.`);
  const source = readFileSync(file, 'utf8');
  const script = ENTRY_SCRIPT.exec(source);
  if (!script || source.match(ANY_SCRIPT)?.length !== 1) throw new Error(`${where} needs exactly one script: <script type="module" src="./<entry>"></script>.`);
  const html = source.replace(ENTRY_SCRIPT, '');
  const relative = RELATIVE_URL.exec(html);
  if (relative) throw new Error(`${where} links ${relative[1]}, a relative URL: use an absolute path to a public file (${PAGE_DIR}/${PAGE_PUBLIC}/).`);
  if (!HEAD_END.test(html)) throw new Error(`${where} needs a </head>, where the host adds its bootstrap.`);
  return { dir, entry: resolve(dir, script[1]!), html };
}

const isChunk = (o: Rollup.OutputChunk | Rollup.OutputAsset): o is Rollup.OutputChunk => o.type === 'chunk';

/** CSS files that the chunks reachable from entries `names` import, statically or dynamically. */
export function reachableCss(output: readonly (Rollup.OutputChunk | Rollup.OutputAsset)[], names: readonly string[]): Set<string> {
  const chunks = new Map(output.filter(isChunk).map((c) => [c.fileName, c]));
  const todo = [...chunks.values()].filter((c) => c.isEntry && names.includes(c.name)).map((c) => c.fileName);
  const seen = new Set<string>();
  const css = new Set<string>();
  for (let f = todo.pop(); f !== undefined; f = todo.pop()) {
    const chunk = chunks.get(f);
    if (seen.has(f) || !chunk) continue;
    seen.add(f);
    for (const s of chunk.viteMetadata?.importedCss ?? []) css.add(s);
    todo.push(...chunk.imports, ...chunk.dynamicImports);
  }
  return css;
}

/** Regular files under `dir`, relative with forward slashes. Throws on a link or anything else. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return filesUnder(join(dir, e.name)).map((f) => `${e.name}/${f}`);
    if (!e.isFile()) throw new Error(`${join(dir, e.name)} is not a file: a page's public files are files and folders only.`);
    return [e.name];
  });
}

/** Writes the page's HTML and public files into the build's browser/ folder; `styles` are its built stylesheets. */
export function writePage(page: SourcePage, outDir: string, styles: readonly string[]): InstalledPage {
  const browser = INSTALLED_PLATFORM_DIRS.browser;
  writeFileSync(join(outDir, browser, BUILT_HTML), page.html);
  const from = join(page.dir, PAGE_PUBLIC);
  const publicFiles = existsSync(from) ? filesUnder(from) : [];
  for (const f of publicFiles) {
    const to = join(outDir, browser, INSTALLED_PAGE_PUBLIC_DIR, f);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(from, f), to);
  }
  return {
    html: `${browser}/${BUILT_HTML}`,
    entry: `${browser}/${PAGE_INPUT}.js`,
    styles: styles.map((s) => `${browser}/${s}`).sort(),
    public: publicFiles.map((f) => `${browser}/${INSTALLED_PAGE_PUBLIC_DIR}/${f}`).sort(),
  };
}
