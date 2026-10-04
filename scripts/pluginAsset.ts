// A plugin's release asset, built from its repo at the release's target commit (docs/plugin-architecture.md §16,
// Releasing): a temporary git worktree there (its sibling plugins at the same commit, for anchors), its own packages
// installed, plugin:check, then the build packed. Release notes record what built it.
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appVersion } from '../appVersion';
import { buildInstalledPlugin } from '../src/main/pluginBuild';
import { installPluginPackages } from '../src/main/marketplace/npm';
import { anchorFolders } from './anchorFolders';
import { checkPlugin, type CheckOptions, type Step } from './pluginCheck';
import { assetName, pack, runGit, type BuiltAsset, type Git } from './pluginRelease';
import { PLUGINS_DIR, gitOut } from './pluginReleaseState';

const REPO_ROOT = resolve(import.meta.dirname, '..');
/** A plugin's own packages exactly as its lockfile pins them (tests included); no install scripts. */
export const NPM_CI_ARGS = ['ci', '--ignore-scripts', '--no-audit', '--no-fund'];
/** The scope of the host's own UI packages, whose installed versions the notes record. */
const UI_PACKAGE_SCOPE = '@cujuju/';

/** Runs plugin:check on a folder; the failed step, or null. */
export type Check = (options: CheckOptions) => Promise<Step | null>;

/** The commit a folder's clone is at, or `unknown` when it isn't in one. */
function commitOf(git: Git, dir: string): string {
  try {
    return gitOut(git, realpathSync(dir), ['rev-parse', 'HEAD']);
  } catch {
    return 'unknown';
  }
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;

/** Each host dependency in UI_PACKAGE_SCOPE with its installed version, comma-separated. */
function uiPackages(): string {
  const { dependencies = {} } = readJson<{ dependencies?: Record<string, string> }>(join(REPO_ROOT, 'package.json'));
  return Object.keys(dependencies)
    .filter((name) => name.startsWith(UI_PACKAGE_SCOPE))
    .map((name) => `${name} ${readJson<{ version: string }>(join(REPO_ROOT, 'node_modules', name, 'package.json')).version}`)
    .join(', ');
}

/** Installs `pluginDir`'s packages and checks it; throws the step that failed. */
export async function installAndCheck(pluginDir: string, check: Check, log: (line: string) => void): Promise<void> {
  await installPluginPackages(pluginDir, NPM_CI_ARGS);
  const step = await check({ pluginDir, log });
  if (step) throw new Error(`plugin:check failed at ${step} (above).`);
}

export interface AssetOptions {
  /** The plugin repo's clone. */
  repoDir: string;
  id: string;
  target: string;
  /** An empty folder for the worktree, the build and the asset. */
  workDir: string;
  git?: Git;
  check?: Check;
  log?: (line: string) => void;
}

/** Builds `id`'s release asset from `target`. */
export async function buildReleaseAsset({ repoDir, id, target, workDir, git = runGit, check = checkPlugin, log = console.log }: AssetOptions): Promise<BuiltAsset> {
  const tree = join(workDir, 'tree');
  gitOut(git, repoDir, ['worktree', 'add', '--detach', tree, target]);
  try {
    const pluginDir = join(tree, PLUGINS_DIR, id);
    await installAndCheck(pluginDir, check, log);
    const buildDir = join(workDir, 'out');
    const host = appVersion(REPO_ROOT);
    const manifest = await buildInstalledPlugin({ pluginDir, outDir: buildDir, appVersion: host, repoRoot: REPO_ROOT, anchorFolders: anchorFolders(pluginDir) });
    const file = join(workDir, assetName(manifest.id, manifest.version));
    await pack(buildDir, file);
    const provenance = `Built from ${target} by ChattyPop ${host} (${commitOf(git, REPO_ROOT)}), ${uiPackages()}, plugin SDK ${manifest.sdk}.`;
    return { file, manifest, notes: `${manifest.description}\n\n${provenance}` };
  } finally {
    const removed = git(repoDir, ['worktree', 'remove', '--force', tree]);
    if (removed.code !== 0) log(`Couldn't remove the build worktree ${tree}: ${removed.stderr.trim()}`);
  }
}
