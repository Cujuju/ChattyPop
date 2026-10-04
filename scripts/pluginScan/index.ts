// plugin:check's scan step (docs/plugin-architecture.md §16): a plugin folder's source against the rules the app's
// tests checked while plugins lived in src/plugins. Tests, node_modules and the page's static files aren't scanned.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { SHARED_ENTRY } from '../../src/main/pluginBuild/descriptor';
import { manifestVersion } from './manifest';
import { allReadersFor } from './allReaders';
import { archiveViolations } from './sql';
import { PAGE_DIR, SHELL_TIER, TESTS_DIR, TEST_FILE, globalViolations, importViolations, importsOf, tablePrefixViolations, userSelectViolations } from './rules';
import { violation, type SourceFile } from './source';

/** The page's static files, copied as they are (a service worker among them): not built, so no plugin code. */
const PAGE_PUBLIC = `${PAGE_DIR}/public`;
const NOT_SOURCE = 'node_modules';
const SCRIPT = /\.[cm]?[jt]sx?$/;
const STYLESHEET = /\.css$/;

/** The plugin's source files, relative to `pluginDir` with forward slashes, sorted. */
function sourceFiles(pluginDir: string): SourceFile[] {
  const skipped = (rel: string): boolean => rel === TESTS_DIR || rel === PAGE_PUBLIC || rel.split('/').at(-1) === NOT_SOURCE;
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const path = join(dir, e.name);
      const rel = relative(pluginDir, path).replaceAll('\\', '/');
      if (e.isDirectory()) return skipped(rel) ? [] : walk(path);
      return (SCRIPT.test(e.name) && !TEST_FILE.test(e.name)) || STYLESHEET.test(e.name) ? [rel] : [];
    });
  return walk(pluginDir).sort().map((rel) => ({ rel, text: readFileSync(join(pluginDir, rel), 'utf8') }));
}

/** The plugin's runtime packages: its package.json `dependencies`, which a source install installs. */
function dependencies(pluginDir: string): Set<string> {
  const file = join(pluginDir, 'package.json');
  if (!existsSync(file)) return new Set();
  return new Set(Object.keys((JSON.parse(readFileSync(file, 'utf8')) as { dependencies?: Record<string, string> }).dependencies ?? {}));
}

/** Release stamping rewrites the manifest's version literal in place (./manifest): a shape it can't find is refused. */
function stampViolations(files: SourceFile[]): string[] {
  const shared = files.find((f) => f.rel === SHARED_ENTRY);
  if (!shared) return [];
  try {
    manifestVersion(shared);
    return [];
  } catch (err) {
    return [violation(shared.rel, 1, (err as Error).message)];
  }
}

export interface ScanOptions {
  pluginDir: string;
  /** Whether the host names this plugin its phone transport (its descriptor's `phone.transport`). */
  isPhoneTransport: boolean;
}

/** Every violation in `pluginDir`'s source, as `file:line: message`; none when it passes. Its folder name is its id (sourceDescriptor). */
export function scanPlugin({ pluginDir: dirIn, isPhoneTransport }: ScanOptions): string[] {
  const pluginDir = resolve(dirIn);
  const id = basename(pluginDir);
  const files = sourceFiles(pluginDir);
  const scripts = files.filter((f) => SCRIPT.test(f.rel));
  const deps = dependencies(pluginDir);
  const found = files.flatMap((f) =>
    SCRIPT.test(f.rel) ? [...importViolations(f, deps), ...tablePrefixViolations(f, id), ...globalViolations(f)] : userSelectViolations(f),
  );
  const shell = scripts.flatMap((f) => importsOf(f).filter((i) => i.spec === SHELL_TIER).map((i) => violation(f.rel, i.line, `${SHELL_TIER}: only the phone transport's plugin may import it`)));
  if (!isPhoneTransport) found.push(...shell);
  found.push(...stampViolations(files));
  return [...found, ...archiveViolations(id, scripts, allReadersFor(pluginDir))];
}
