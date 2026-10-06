// npm for a plugin folder's own packages: source installs (sourceBuild.ts) and plugin releases (scripts/). No electron
// import, so the scripts can load it.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { BYTES_PER_MB, MS_PER_MIN } from '../../shared/units';

/** Installing a plugin's packages on a slow link. */
const DEPENDENCY_INSTALL_TIMEOUT_MS = 5 * MS_PER_MIN;
/** npm's output kept for an error message. */
const NPM_OUTPUT_MAX_BYTES = BYTES_PER_MB;
/** npm's last lines quoted when it fails. */
const NPM_ERROR_LINES = 3;

/** npm's CLI script, beside node in a Windows Node.js install (and nvm-windows' versions). */
const WINDOWS_NPM_CLI = join('node_modules', 'npm', 'bin', 'npm-cli.js');
/** cmd.exe and Windows tools (which npm may use for git) search the working folder first unless this is set. */
const NO_CWD_SEARCH = { NoDefaultCurrentDirectoryInExePath: '1' };

const run = promisify(execFile);

/** How to run npm without a shell. */
export interface NpmCommand {
  file: string;
  args: string[];
}

/** Finds npm only in absolute PATH folders, avoiding plugin-directory substitution. Runs shell-free; Windows shims use adjacent Node. Returns null if absent. */
export function npmCommand(path: string, platform: NodeJS.Platform, exists: (file: string) => boolean = existsSync): NpmCommand | null {
  for (const dir of path.split(delimiter).filter((d) => d && isAbsolute(d))) {
    if (platform !== 'win32') {
      if (exists(join(dir, 'npm'))) return { file: join(dir, 'npm'), args: [] };
    } else if (exists(join(dir, 'node.exe')) && exists(join(dir, WINDOWS_NPM_CLI))) {
      return { file: join(dir, 'node.exe'), args: [join(dir, WINDOWS_NPM_CLI)] };
    }
  }
  return null;
}

/** PATH's value; Windows spells the name in any case. */
const pathValue = (env: NodeJS.ProcessEnv): string => Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '';

/** Whether `pluginDir`'s package.json lists runtime packages. */
function hasDependencies(pluginDir: string): boolean {
  const file = join(pluginDir, 'package.json');
  if (!existsSync(file)) return false;
  const pkg = JSON.parse(readFileSync(file, 'utf8')) as { dependencies?: Record<string, string> };
  return Object.keys(pkg.dependencies ?? {}).length > 0;
}

/** Runs npm with `args` in `pluginDir` when its package.json lists runtime packages; otherwise does nothing. */
export async function installPluginPackages(pluginDir: string, args: readonly string[]): Promise<void> {
  if (!hasDependencies(pluginDir)) return;
  const npm = npmCommand(pathValue(process.env), process.platform);
  if (!npm) throw new Error("Installing this plugin's packages needs npm (it comes with Node.js), which isn't on this PC's PATH.");
  try {
    await run(npm.file, [...npm.args, ...args], {
      cwd: pluginDir,
      env: { ...process.env, ...NO_CWD_SEARCH },
      timeout: DEPENDENCY_INSTALL_TIMEOUT_MS,
      maxBuffer: NPM_OUTPUT_MAX_BYTES,
      windowsHide: true,
    });
  } catch (err) {
    const { stderr } = err as { stderr?: unknown };
    throw new Error(`npm couldn't install the plugin's packages: ${String(stderr ?? '').trim().split('\n').slice(-NPM_ERROR_LINES).join(' ') || String(err)}`);
  }
}
