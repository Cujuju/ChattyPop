// Releases every plugin in a plugin repo that needs it (docs/plugin-architecture.md §16, Releasing):
// `pnpm plugin:release-changed <pluginsRepoDir> --repo <owner/name> [--dry-run] [--only ids] [--sdk-rebuild]`.
// Finishes pending versions first, then stamps a new version on each changed plugin in one release-intent commit,
// pushes it, and publishes each at that commit. CI runs it on every push to main (the plugin repos' workflow).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sourceDescriptor } from '../src/main/pluginBuild/descriptor';
import { PLUGIN_SDK_VERSION, REPO_PATTERN, sdkMismatch } from '../src/shared/installedPlugins';
import { anchorFolders } from './anchorFolders';
import { buildReleaseAsset, installAndCheck, type Check } from './pluginAsset';
import { checkPlugin } from './pluginCheck';
import { ensureReleased, runGh, runGit, type BuiltAsset, type Gh, type Git } from './pluginRelease';
import { MAIN, PLUGINS_DIR, gitOut, intentSubject, raisedVersion, readStates, releaseTag, sharedPath, type PluginState } from './pluginReleaseState';
import { stampVersion } from './pluginScan/manifest';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const USAGE = 'Usage: pnpm plugin:release-changed <pluginsRepoDir> --repo <owner/name> [--dry-run] [--only id,id] [--sdk-rebuild]';
const BRANCH = 'main';
/** A GitHub remote URL's `owner/name` (https or ssh, `.git` or not). */
const GITHUB_REMOTE = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/i;

export interface ReleaseChangedOptions {
  /** The plugin repo's clone, on main. */
  repoDir: string;
  repo: string;
  dryRun: boolean;
  /** Only these plugin ids; all when absent. */
  only?: readonly string[];
  /** Also release plugins whose newest listed release was built for another PLUGIN_SDK_VERSION this host can still run. */
  sdkRebuild: boolean;
  gh?: Gh;
  git?: Git;
  check?: Check;
  /** Builds a release asset; defaults to buildReleaseAsset. */
  buildAsset?: (id: string, target: string, workDir: string) => Promise<BuiltAsset>;
  log?: (line: string) => void;
}

export interface ReleaseChangedResult {
  /** Tags published and listed by this run. */
  released: string[];
  /** Why each plugin that needed a release didn't get one. */
  failed: string[];
}

/** Throws unless `dir` is a clean clone of `repo` on main, at the fetched origin/main. */
function preflight(git: Git, dir: string, repo: string): void {
  if (!REPO_PATTERN.test(repo)) throw new Error(`--repo must be owner/name: ${repo}`);
  const origin = GITHUB_REMOTE.exec(gitOut(git, dir, ['remote', 'get-url', 'origin']))?.[1];
  if (origin?.toLowerCase() !== repo.toLowerCase()) throw new Error(`${dir} is a clone of ${origin ?? 'another host'}, not ${repo}.`);
  const branch = git(dir, ['symbolic-ref', '--short', 'HEAD']).stdout.trim();
  if (branch !== BRANCH) throw new Error(`${dir} is on ${branch || 'a detached HEAD'}; releases come from ${BRANCH}.`);
  if (gitOut(git, dir, ['status', '--porcelain'])) throw new Error(`${dir} has uncommitted changes.`);
  gitOut(git, dir, ['fetch', 'origin', BRANCH, '--tags']);
  if (gitOut(git, dir, ['rev-parse', 'HEAD']) !== gitOut(git, dir, ['rev-parse', MAIN])) throw new Error(`${dir}'s ${BRANCH} is not at ${MAIN}: pull first.`);
}

/** Brings the clone up to origin/main after the index writes moved it (fast-forward only). */
function catchUp(git: Git, dir: string): void {
  gitOut(git, dir, ['fetch', 'origin', BRANCH, '--tags']);
  gitOut(git, dir, ['merge', '--ff-only', MAIN]);
}

const summary = (s: PluginState): string =>
  s.kind === 'settled' ? `${s.id} ${s.version}: released${s.changed ? `, changed (${s.changed.join(', ')})` : ''}`
    : s.kind === 'pending' ? `${s.id} ${s.version}: pending at ${s.target.slice(0, 12)}`
      : s.kind === 'unstamped' ? `${s.id} ${s.version}: not yet released`
        : `${s.id}: ${s.reason}`;

/** Runs the release; see the file comment. */
export async function releaseChanged(options: ReleaseChangedOptions): Promise<ReleaseChangedResult> {
  const { repo, dryRun, only, sdkRebuild, gh = runGh, git = runGit, check = checkPlugin, log = console.log } = options;
  const dir = resolve(options.repoDir);
  const build = options.buildAsset ?? ((id, target, workDir) => buildReleaseAsset({ repoDir: dir, id, target, workDir, git, check, log }));
  const result: ReleaseChangedResult = { released: [], failed: [] };
  const publish = async (id: string, version: string, target: string): Promise<boolean> => {
    const workDir = mkdtempSync(join(tmpdir(), `chattypop-release-${id}-`));
    try {
      const done = await ensureReleased({ repo, id, version, target, workDir, gh, log, buildAsset: (out) => build(id, target, out) });
      result.released.push(done.tag);
      return done.listed;
    } catch (err) {
      result.failed.push(`${releaseTag(id, version)}: ${(err as Error).message}`);
      return false;
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  };

  preflight(git, dir, repo);
  let states = readStates(git, dir, only);
  for (const s of states) log(summary(s));
  for (const s of states) if (s.kind === 'broken') result.failed.push(`${s.id}: ${s.reason}`);

  const pending = states.filter((s) => s.kind === 'pending');
  if (dryRun) {
    for (const s of pending) log(`Would publish ${releaseTag(s.id, s.version)} at ${s.target}`);
  } else if (pending.length) {
    for (const s of pending) await publish(s.id, s.version, s.target);
    // Listing commits moved main: stamp from it, with any edits that landed after the pending stamps.
    catchUp(git, dir);
    states = readStates(git, dir, only);
  }

  const planned = states.flatMap((s) => {
    if (s.kind === 'unstamped') return [{ id: s.id, version: s.version }];
    if (s.kind !== 'settled') return [];
    // A release this SDK can't run (another major) is rebuilt on any run, so a new major reaches every plugin unasked;
    // the app keeps offering older hosts the newest release they can run.
    const rebuild = sdkMismatch(s.listed.sdk) !== null || (sdkRebuild && s.listed.sdk !== PLUGIN_SDK_VERSION);
    return s.changed || rebuild ? [{ id: s.id, version: raisedVersion(s.version, s.changed ?? ['patch']) }] : [];
  });
  for (const p of planned) log(`${dryRun ? 'Would release' : 'Releasing'} ${releaseTag(p.id, p.version)}`);
  if (!planned.length) return result;

  // Every changed plugin passes before anything is written.
  let passed = true;
  for (const p of planned) {
    try {
      await installAndCheck(join(dir, PLUGINS_DIR, p.id), check, log);
    } catch (err) {
      passed = false;
      result.failed.push(`${p.id}: ${(err as Error).message} Nothing was stamped.`);
    }
  }
  if (!passed || dryRun) return result;
  const target = await stamp(git, dir, planned);
  for (const p of planned) await publish(p.id, p.version, target);
  catchUp(git, dir);
  return result;
}

/** Writes each planned version, checks the stamped descriptors, commits the release intent and pushes it; its commit. */
async function stamp(git: Git, dir: string, planned: readonly { id: string; version: string }[]): Promise<string> {
  const paths = planned.map((p) => sharedPath(p.id));
  try {
    for (const p of planned) {
      const file = join(dir, sharedPath(p.id));
      writeFileSync(file, stampVersion(readFileSync(file, 'utf8'), p.version, sharedPath(p.id)));
      const pluginDir = join(dir, PLUGINS_DIR, p.id);
      const { manifest } = await sourceDescriptor(pluginDir, REPO_ROOT, anchorFolders(pluginDir));
      if (manifest.id !== p.id || manifest.version !== p.version) throw new Error(`stamped ${p.id} evaluates to ${manifest.id} ${manifest.version}, not ${p.version}.`);
    }
  } catch (err) {
    gitOut(git, dir, ['checkout', '--', ...paths]);
    throw err;
  }
  gitOut(git, dir, ['add', '--', ...paths]);
  // A first release whose literal needs no change still gets its intent commit.
  gitOut(git, dir, ['commit', '--allow-empty', '-m', intentSubject(planned.map((p) => releaseTag(p.id, p.version)))]);
  const pushed = git(dir, ['push', 'origin', `HEAD:${BRANCH}`]);
  if (pushed.code !== 0) {
    // Only this run's own commit is undone; the push that beat it has its own run, which starts from fresh main.
    gitOut(git, dir, ['reset', '--keep', 'HEAD~1']);
    throw new Error(`Pushing the release intent was rejected; nothing is pending. ${pushed.stderr.trim()}`);
  }
  return gitOut(git, dir, ['rev-parse', 'HEAD']);
}

/** CLI entry (scripts/runTs.mjs). */
export async function main(args: string[]): Promise<number> {
  const valued = ['--repo', '--only'];
  const value = (flag: string): string | undefined => {
    const at = args.indexOf(flag);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const values = new Set(valued.map((f) => args.indexOf(f) + 1).filter((i) => i > 0));
  const dirs = args.filter((a, i) => !a.startsWith('--') && !values.has(i));
  const unknown = args.filter((a, i) => a.startsWith('--') && !values.has(i) && ![...valued, '--dry-run', '--sdk-rebuild'].includes(a));
  const repo = value('--repo');
  const onlyArg = value('--only');
  const badValue = valued.some((f) => args.includes(f) && (!value(f) || value(f)!.startsWith('--')));
  if (dirs.length !== 1 || !repo || badValue || unknown.length) {
    console.error(USAGE);
    return 1;
  }
  const only = onlyArg?.split(',').map((s) => s.trim()).filter(Boolean);
  const r = await releaseChanged({ repoDir: dirs[0]!, repo, dryRun: args.includes('--dry-run'), only, sdkRebuild: args.includes('--sdk-rebuild') });
  console.log(`Released: ${r.released.join(', ') || 'none'}`);
  if (r.failed.length) console.error(`Not released:\n${r.failed.join('\n')}`);
  return r.failed.length ? 1 : 0;
}
