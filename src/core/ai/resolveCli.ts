import { existsSync, readFileSync } from 'node:fs';
import { delimiter, extname, join } from 'node:path';

/** A command runnable with spawn() and no shell. */
export interface Launch {
  command: string;
  args: string[];
}

export const IS_WINDOWS = process.platform === 'win32';
/** npm launcher shims Node cannot spawn without a shell (spawn EINVAL since Node 20.12). */
const SHIM_EXTS = new Set(['.cmd', '.bat', '.ps1']);

/** A native executable's file name: `name.exe` on Windows. */
export const exeName = (name: string): string => (IS_WINDOWS ? `${name}.exe` : name);

const pathDirs = (): string[] => (process.env['PATH'] ?? '').split(delimiter).filter(Boolean);

function findOnPath(file: string): string | undefined {
  for (const dir of pathDirs()) {
    const full = join(dir, file);
    if (existsSync(full)) return full;
  }
  return undefined;
}

/** A native executable on PATH (`name.exe` on Windows), or undefined. */
export const findExecutable = (name: string): string | undefined => findOnPath(exeName(name));

/** Resolves shell-free CLI launches. Windows npm shims resolve to their JavaScript bin and adjacent or PATH Node. */
export function resolveCli(name: string, npmPackage: string): Launch | undefined {
  if (!IS_WINDOWS) {
    const found = findOnPath(name);
    return found ? { command: found, args: [] } : undefined;
  }
  const exts = (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase());
  for (const dir of pathDirs()) {
    for (const ext of ['.exe', ...exts.filter((e) => e !== '.exe'), '.ps1']) {
      const full = join(dir, name + ext);
      if (!existsSync(full)) continue;
      if (ext === '.exe') return { command: full, args: [] };
      if (SHIM_EXTS.has(extname(full).toLowerCase())) {
        const launch = followNpmShim(dir, name, npmPackage);
        if (launch) return launch;
      }
    }
  }
  return undefined;
}

function followNpmShim(shimDir: string, name: string, npmPackage: string): Launch | undefined {
  const pkgDir = join(shimDir, 'node_modules', ...npmPackage.split('/'));
  const pkgJson = join(pkgDir, 'package.json');
  if (!existsSync(pkgJson)) return undefined;
  const pkg = JSON.parse(readFileSync(pkgJson, 'utf8')) as { bin?: string | Record<string, string> };
  const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[name];
  if (!binRel) return undefined;
  const script = join(pkgDir, binRel);
  if (extname(script).toLowerCase() === '.exe') return { command: script, args: [] };
  const localNode = join(shimDir, 'node.exe');
  const node = existsSync(localNode) ? localNode : findOnPath('node.exe');
  return node ? { command: node, args: [script] } : undefined;
}
