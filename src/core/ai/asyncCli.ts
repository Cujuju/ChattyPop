import { access, readFile } from 'node:fs/promises';
import { delimiter, extname, join } from 'node:path';
import { IS_WINDOWS, exeName, type Launch } from './resolveCli';

/** Successful discovery is reused briefly; refresh and PATH changes take effect immediately. */
const DISCOVERY_TTL_MS = 30_000;
/** CLI names are a small fixed provider set; cap retained PATH variants across environment changes. */
const DISCOVERY_CACHE_MAX = 16;
const SHIMS = new Set(['.cmd', '.bat', '.ps1']);
const cache = new Map<string, { expires: number; value: Promise<Launch | undefined> }>();
const exists = async (path: string): Promise<boolean> => { try { await access(path); return true; } catch { return false; } };

/** Async PATH/npm-shim discovery. Missing installs and failures are retried on the next request. */
export function resolveCliAsync(name: string, npmPackage: string, refresh = false): Promise<Launch | undefined> {
  const path = process.env.PATH ?? '';
  const extensions = process.env.PATHEXT ?? '.EXE;.CMD;.BAT';
  const key = JSON.stringify([name, npmPackage, path, extensions]);
  const cached = cache.get(key);
  if (!refresh && cached && cached.expires > Date.now()) return cached.value;
  const value = discover(name, npmPackage, path.split(delimiter).filter(Boolean), extensions);
  const entry = { expires: Date.now() + DISCOVERY_TTL_MS, value };
  cache.delete(key); cache.set(key, entry);
  if (cache.size > DISCOVERY_CACHE_MAX) cache.delete(cache.keys().next().value!);
  const forget = (): void => { if (cache.get(key) === entry) cache.delete(key); };
  void value.then((launch) => { if (!launch) forget(); }, forget);
  return value;
}

async function discover(name: string, npmPackage: string, dirs: string[], extensions: string): Promise<Launch | undefined> {
  const find = async (file: string): Promise<string | undefined> => {
    for (const dir of dirs) { const full = join(dir, file); if (await exists(full)) return full; }
    return undefined;
  };
  if (!IS_WINDOWS) { const command = await find(name); return command ? { command, args: [] } : undefined; }
  const exts = extensions.split(';').map((ext) => ext.toLowerCase());
  for (const dir of dirs) for (const ext of ['.exe', ...exts.filter((ext) => ext !== '.exe'), '.ps1']) {
    const command = join(dir, name + ext);
    if (!await exists(command)) continue;
    if (ext === '.exe') return { command, args: [] };
    if (!SHIMS.has(extname(command).toLowerCase())) continue;
    const pkgDir = join(dir, 'node_modules', ...npmPackage.split('/'));
    const pkgJson = join(pkgDir, 'package.json');
    if (!await exists(pkgJson)) continue;
    const pkg = JSON.parse(await readFile(pkgJson, 'utf8')) as { bin?: string | Record<string, string> };
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[name];
    if (!bin) continue;
    const script = join(pkgDir, bin);
    if (extname(script).toLowerCase() === '.exe') return { command: script, args: [] };
    const localNode = join(dir, exeName('node'));
    const node = await exists(localNode) ? localNode : await find(exeName('node'));
    if (node) return { command: node, args: [script] };
  }
  return undefined;
}
