// Checks external plugins in order: typecheck, styles, scan, build, tests. Stops at the first failure.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { mergeConfig } from 'vitest/config';
import { startVitest } from 'vitest/node';
import { appVersion } from '../appVersion';
import { buildInstalledPlugin, checkStyles } from '../src/main/pluginBuild';
import { SHARED_ENTRY, sourceDescriptor } from '../src/main/pluginBuild/descriptor';
import { testConfig } from '../vitest.config';
import { anchorFolders } from './anchorFolders';
import { scanPlugin, scanWarnings } from './pluginScan';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const USAGE = 'Usage: pnpm plugin:check <pluginDir>';
/** The static steps first: they fail fast, before the builds. */
export const STEPS = ['typecheck', 'styles', 'scan', 'build', 'tests'] as const;
export type Step = (typeof STEPS)[number];

/** The config a plugin outside this checkout type-checks with; the editor template extends it too. */
const PLUGIN_TSCONFIG = 'tsconfig.plugin.json';
const TSC = 'node_modules/typescript/bin/tsc';
/** A plugin's test files, relative to its folder. */
const TEST_FILES = '**/*.test.ts';
const NOT_SOURCE = '**/node_modules/**';
/** Static page files served without compilation. */
const PAGE_PUBLIC = 'page/public/**';

/** Per-side host type configuration and plugin source folders. */
const PROJECTS = {
  node: { repoConfig: 'tsconfig.node.json', dirs: ['shared', 'core', 'main', 'tests'], tests: true },
  browser: { repoConfig: 'tsconfig.web.json', dirs: ['shared', 'renderer', 'page'], tests: false },
} as const;

const posix = (p: string): string => p.replaceAll('\\', '/');

/** Runs this checkout's tsc; its exit code and output. */
function tsc(args: readonly string[]): { code: number; output: string } {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, TSC), ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (r.error) throw r.error;
  return { code: r.status ?? 1, output: `${r.stdout}${r.stderr}`.trim() };
}

/** Resolves host libraries, types, and ambient declarations as absolute paths. */
function repoSide(repoConfig: string): { options: { lib: string[]; types: string[] }; declarations: string[] } {
  const r = tsc(['-p', repoConfig, '--showConfig']);
  if (r.code !== 0) throw new Error(`tsc --showConfig ${repoConfig} failed:\n${r.output}`);
  const { compilerOptions: o, files } = JSON.parse(r.output) as { compilerOptions: { lib: string[]; types: string[] }; files: string[] };
  return { options: { lib: o.lib, types: o.types }, declarations: files.filter((f) => f.endsWith('.d.ts')).map((f) => posix(resolve(REPO_ROOT, f))) };
}

/** Type-checks each side of `pluginDir` with a tsconfig written to `work`; throws tsc's report. */
function typecheck(pluginDir: string, work: string): void {
  const dir = posix(pluginDir);
  for (const [side, p] of Object.entries(PROJECTS)) {
    const config = join(work, `tsconfig.${side}.json`);
    const repo = repoSide(p.repoConfig);
    const include = [...p.dirs.map((d) => `${dir}/${d}/**/*`), ...(p.tests ? [`${dir}/${TEST_FILES}`] : []), ...repo.declarations];
    const tsconfig = { extends: posix(join(REPO_ROOT, PLUGIN_TSCONFIG)), compilerOptions: repo.options, include, exclude: [`${dir}/${NOT_SOURCE}`, `${dir}/${PAGE_PUBLIC}`] };
    writeFileSync(config, JSON.stringify(tsconfig, null, 2));
    const r = tsc(['-p', config, '--pretty', 'false']);
    if (r.code !== 0) throw new Error(`${side} side:\n${r.output}`);
  }
}

/** A bare package specifier (`electron`, `@scope/pkg/sub`), not a path, alias target or virtual module. */
const BARE_PACKAGE = /^(?:@[\w.-]+\/)?[\w.-]+(?:\/.*)?$/;

/** Resolves missing plugin packages from the host checkout, sharing dependency instances with host modules. */
function hostPackages(): Plugin {
  const fromCheckout = posix(join(REPO_ROOT, 'package.json'));
  return {
    name: 'chattypop-plugin-check-host-packages',
    async resolveId(source, importer, options) {
      if (!importer || !BARE_PACKAGE.test(source) || posix(importer).startsWith(`${posix(REPO_ROOT)}/`)) return null;
      return (await this.resolve(source, importer, { ...options, skipSelf: true })) ?? this.resolve(source, fromCheckout, { ...options, skipSelf: true });
    },
  };
}

/** Runs plugin tests with a registry containing only pluginDir; failures throw. */
async function runTests(pluginDir: string): Promise<void> {
  const config = mergeConfig(testConfig({ dirs: dirname(pluginDir), selection: basename(pluginDir) }), { plugins: [hostPackages()], test: { dir: pluginDir, passWithNoTests: true } });
  // Replaced, not merged: the checkout's own test globs don't apply.
  Object.assign(config.test!, { include: [TEST_FILES], exclude: [NOT_SOURCE] });
  // Isolates each Vitest exit code, restoring the process’s prior code after the run.
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  let reported: typeof exitCode;
  let vitest: Awaited<ReturnType<typeof startVitest>>;
  try {
    vitest = await startVitest('test', [], { root: REPO_ROOT, config: false, run: true, watch: false }, config);
    await vitest.close();
  } finally {
    reported = process.exitCode;
    process.exitCode = exitCode;
  }
  const failed = vitest.state.getCountOfFailedTests() + vitest.state.getUnhandledErrors().length;
  if (failed || reported) throw new Error(failed ? `${failed} failed (above).` : 'vitest reported a failure (above).');
}

/** Scans the plugin's source (scripts/pluginScan): logs each warning, then throws every violation, one per line. */
async function scan(pluginDir: string, log: (line: string) => void): Promise<void> {
  // Descriptor validation first rejects folder names that differ from plugin IDs.
  const descriptor = await sourceDescriptor(pluginDir, REPO_ROOT, anchorFolders(pluginDir));
  for (const w of scanWarnings(pluginDir)) log(`plugin:check warning: ${w}`);
  const violations = scanPlugin({ pluginDir, isPhoneTransport: descriptor.phone?.transport === true });
  if (violations.length) throw new Error(violations.join('\n'));
}

export interface CheckOptions {
  pluginDir: string;
  log?: (line: string) => void;
}

/** Runs every step on `pluginDir`; the step that failed, or null. */
export async function checkPlugin({ pluginDir: dirIn, log = console.log }: CheckOptions): Promise<Step | null> {
  const pluginDir = resolve(dirIn);
  if (!existsSync(join(pluginDir, SHARED_ENTRY))) {
    log(`${pluginDir} is not a plugin folder: it has no ${SHARED_ENTRY}.`);
    return STEPS[0];
  }
  const work = mkdtempSync(join(tmpdir(), 'chattypop-plugin-check-'));
  const steps: Record<Step, () => unknown> = {
    typecheck: () => typecheck(pluginDir, work),
    styles: () => checkStyles(pluginDir, REPO_ROOT),
    scan: () => scan(pluginDir, log),
    build: () => buildInstalledPlugin({ pluginDir, outDir: join(work, 'build'), appVersion: appVersion(REPO_ROOT), repoRoot: REPO_ROOT, anchorFolders: anchorFolders(pluginDir) }),
    tests: () => runTests(pluginDir),
  };
  try {
    for (const step of STEPS) {
      try {
        await steps[step]();
      } catch (err) {
        log(`plugin:check failed at ${step}:\n${(err as Error).message}`);
        return step;
      }
      log(`plugin:check ${step}: ok`);
    }
    return null;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** CLI entry (scripts/runTs.mjs). */
export async function main(args: string[]): Promise<number> {
  if (args.length !== 1 || args[0]!.startsWith('--')) {
    console.error(USAGE);
    return 1;
  }
  return (await checkPlugin({ pluginDir: args[0]! })) === null ? 0 : 1;
}
