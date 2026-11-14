// Plugin releases without commits to main. `--stamp`, on a pull request's branch, raises each changed plugin's version and refreshes the
// branch's marketplace.json copy in one commit for that pull request. Plugin-repository CI runs the default (publish) on main pushes:
// it publishes every plugin whose version has no release yet, finishing pending ones, and lists them in the index release's asset.
// `--check` (pull request CI) fails when a changed plugin wasn't stamped. See docs/plugin-architecture.md, Releasing.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sourceDescriptor } from '../src/main/pluginBuild/descriptor';
import { PLUGIN_SDK_VERSION, REPO_PATTERN, sdkMismatch } from '../src/shared/installedPlugins';
import { MARKETPLACE_INDEX_FILE, MARKETPLACE_INDEX_TAG } from '../src/shared/marketplace';
import { anchorFolders } from './anchorFolders';
import { buildReleaseAsset, installAndCheck, type Check } from './pluginAsset';
import { checkPlugin } from './pluginCheck';
import { ensureReleased, indexText, readIndex, runGh, runGit, seedIndex, type BuiltAsset, type Gh, type Git, type IndexStore } from './pluginRelease';
import { MAIN, PLUGINS_DIR, branchIndex, gitOut, raisedVersion, readStates, releaseTag, sharedPath, type PluginState } from './pluginReleaseState';
import { stampVersion } from './pluginScan/manifest';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const USAGE = 'Usage: pnpm plugin:release-changed <pluginsRepoDir> --repo <owner/name> [--stamp | --check] [--dry-run] [--only id,id] [--sdk-rebuild]';
const BRANCH = 'main';
/** A GitHub remote URL's `owner/name` (https or ssh, `.git` or not). */
const GITHUB_REMOTE = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/i;
/** The stamp commit's subject starts so; never INTENT_PREFIX, which marks the release intents of the old flow. */
const STAMP_PREFIX = 'chore: stamp ';
const SYNC_SUBJECT = `chore: sync ${MARKETPLACE_INDEX_FILE} from the ${MARKETPLACE_INDEX_TAG} release`;

/** publish (CI on main), stamp (a pull request's branch) or check (pull request CI, read-only). */
export type ReleaseMode = 'publish' | 'stamp' | 'check';

export interface ReleaseChangedOptions {
  /** The plugin repo's clone: on main to publish, on a pull request's branch to stamp, any commit to check. */
  repoDir: string;
  repo: string;
  /** Defaults to publish. */
  mode?: ReleaseMode;
  dryRun: boolean;
  /** Only these plugin ids; all when absent. */
  only?: readonly string[];
  /** Stamps plugins built against another supported SDK version too. */
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
  /** Tags whose versions this run stamped (stamp mode). */
  stamped: string[];
  /** Why each plugin that needed a release (or a stamp) didn't get one. */
  failed: string[];
}

/** Throws unless `dir` is a clone of `repo`; fetches main and tags. */
function fetchMain(git: Git, dir: string, repo: string): void {
  if (!REPO_PATTERN.test(repo)) throw new Error(`--repo must be owner/name: ${repo}`);
  const origin = GITHUB_REMOTE.exec(gitOut(git, dir, ['remote', 'get-url', 'origin']))?.[1];
  if (origin?.toLowerCase() !== repo.toLowerCase()) throw new Error(`${dir} is a clone of ${origin ?? 'another host'}, not ${repo}.`);
  gitOut(git, dir, ['fetch', 'origin', BRANCH, '--tags']);
}

/** Throws unless `dir` is a clean clone of `repo` on main, at the fetched origin/main. */
function preflightMain(git: Git, dir: string, repo: string): void {
  if (!REPO_PATTERN.test(repo)) throw new Error(`--repo must be owner/name: ${repo}`);
  const branch = git(dir, ['symbolic-ref', '--short', 'HEAD']).stdout.trim();
  if (branch !== BRANCH) throw new Error(`${dir} is on ${branch || 'a detached HEAD'}; releases come from ${BRANCH}.`);
  if (gitOut(git, dir, ['status', '--porcelain'])) throw new Error(`${dir} has uncommitted changes.`);
  fetchMain(git, dir, repo);
  if (gitOut(git, dir, ['rev-parse', 'HEAD']) !== gitOut(git, dir, ['rev-parse', MAIN])) throw new Error(`${dir}'s ${BRANCH} is not at ${MAIN}: pull first.`);
}

/** Throws unless `dir` is a clean clone of `repo` on a branch other than main that contains the fetched origin/main. */
function preflightBranch(git: Git, dir: string, repo: string): void {
  if (!REPO_PATTERN.test(repo)) throw new Error(`--repo must be owner/name: ${repo}`);
  const branch = git(dir, ['symbolic-ref', '--short', 'HEAD']).stdout.trim();
  if (!branch) throw new Error(`${dir} is on a detached HEAD; stamp on your pull request's branch.`);
  if (branch === BRANCH) throw new Error(`${dir} is on ${BRANCH}; stamp on your pull request's branch, never ${BRANCH}.`);
  if (gitOut(git, dir, ['status', '--porcelain'])) throw new Error(`${dir} has uncommitted changes.`);
  fetchMain(git, dir, repo);
  if (git(dir, ['merge-base', '--is-ancestor', MAIN, 'HEAD']).code !== 0) throw new Error(`${branch} doesn't contain ${MAIN}: merge or rebase it first, so the stamp sees every release.`);
}

const summary = (s: PluginState): string =>
  s.kind === 'settled' ? `${s.id} ${s.version}: released${s.changed ? `, changed (${s.changed.join(', ')})` : ''}`
    : s.kind === 'pending' ? `${s.id} ${s.version}: pending at ${s.target.slice(0, 12)}`
      : s.kind === 'unstamped' ? `${s.id} ${s.version}: not yet released${s.target ? `, tagged at ${s.target.slice(0, 12)}` : ''}`
        : `${s.id}: ${s.reason}`;

/** Whether a settled plugin's newest release needs rebuilding: always for an SDK this host can't run, for any other SDK with `sdkRebuild`. */
const needsRebuild = (s: Extract<PluginState, { kind: 'settled' }>, sdkRebuild: boolean): boolean =>
  sdkMismatch(s.listed.sdk) !== null || (sdkRebuild && s.listed.sdk !== PLUGIN_SDK_VERSION);

const STAMP_HINT = 'stamp it in a pull request (pnpm plugin:release-changed <dir> --repo <owner/name> --stamp)';
const rebuildHint = (sdkRebuild: boolean): string => `stamp a rebuild in a pull request (--stamp${sdkRebuild ? ' --sdk-rebuild' : ''})`;

/** Runs the release; see the file comment. */
export async function releaseChanged(options: ReleaseChangedOptions): Promise<ReleaseChangedResult> {
  const { mode = 'publish' } = options;
  const dir = resolve(options.repoDir);
  const result: ReleaseChangedResult = { released: [], stamped: [], failed: [] };
  const workDir = mkdtempSync(join(tmpdir(), 'chattypop-release-'));
  try {
    if (mode === 'publish') await publish(options, dir, workDir, result);
    else if (mode === 'stamp') await stamp(options, dir, workDir, result);
    else await checkStamps(options, dir, workDir, result);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  return result;
}

/** `rev`'s marketplace.json text, or null. */
function branchText(git: Git, dir: string, rev: string): string | null {
  const r = git(dir, ['show', `${rev}:${MARKETPLACE_INDEX_FILE}`]);
  return r.code === 0 ? r.stdout : null;
}

/** CI on main: publishes every unreleased version, committing nothing. */
async function publish(options: ReleaseChangedOptions, dir: string, workDir: string, result: ReleaseChangedResult): Promise<void> {
  const { repo, dryRun, only, sdkRebuild, gh = runGh, git = runGit, check = checkPlugin, log = console.log } = options;
  const build = options.buildAsset ?? ((id, target, out) => buildReleaseAsset({ repoDir: dir, id, target, workDir: out, git, check, log }));
  preflightMain(git, dir, repo);
  const head = gitOut(git, dir, ['rev-parse', MAIN]);
  const store: IndexStore = { fallback: () => branchIndex(git, dir), target: head };
  if (!dryRun && (await seedIndex(gh, repo, store, workDir))) log(`Created the ${MARKETPLACE_INDEX_TAG} release from main's ${MARKETPLACE_INDEX_FILE}`);
  const release = async (id: string, version: string, target: string): Promise<void> => {
    if (dryRun) return void log(`Would publish ${releaseTag(id, version)} at ${target}`);
    const out = mkdtempSync(join(workDir, `${id}-`));
    try {
      const done = await ensureReleased({ repo, id, version, target, workDir: out, index: store, gh, log, buildAsset: (to) => build(id, target, to) });
      result.released.push(done.tag);
    } catch (err) {
      result.failed.push(`${releaseTag(id, version)}: ${(err as Error).message}`);
    }
  };

  let states = readStates(git, dir, await readIndex(gh, repo, store, workDir), only);
  for (const s of states) log(summary(s));
  const pending = states.filter((s) => s.kind === 'pending');
  for (const s of pending) await release(s.id, s.version, s.target);
  // A finished pending version is tagged and listed now: fetch only tags (this run stays at `head`) and read the index again.
  if (pending.length && !dryRun) {
    gitOut(git, dir, ['fetch', 'origin', 'refs/tags/*:refs/tags/*']);
    states = readStates(git, dir, await readIndex(gh, repo, store, workDir), only);
  }
  for (const s of states) {
    if (s.kind === 'broken') result.failed.push(`${s.id}: ${s.reason}`);
    else if (s.kind === 'unstamped') await release(s.id, s.version, s.target ?? head);
    else if (s.kind === 'settled' && s.changed) result.failed.push(`${s.id}: changed since ${releaseTag(s.id, s.version)} without a raised version; ${STAMP_HINT}.`);
    else if (s.kind === 'settled' && needsRebuild(s, sdkRebuild)) result.failed.push(`${s.id}: ${releaseTag(s.id, s.version)} is built for SDK ${s.listed.sdk}; ${rebuildHint(sdkRebuild)}.`);
  }
}

/** Pull request CI: fails for each plugin changed without a raised version. Writes nothing. */
async function checkStamps(options: ReleaseChangedOptions, dir: string, workDir: string, result: ReleaseChangedResult): Promise<void> {
  const { repo, only, sdkRebuild, gh = runGh, git = runGit, log = console.log } = options;
  fetchMain(git, dir, repo);
  const store: IndexStore = { fallback: () => branchIndex(git, dir), target: gitOut(git, dir, ['rev-parse', MAIN]) };
  const index = await readIndex(gh, repo, store, workDir);
  const states = readStates(git, dir, index, only, 'HEAD');
  for (const s of states) log(summary(s));
  for (const s of states) {
    if (s.kind === 'broken') result.failed.push(`${s.id}: ${s.reason}`);
    else if (s.kind === 'settled' && s.changed) result.failed.push(`${s.id}: changed since ${releaseTag(s.id, s.version)} without a raised version; ${STAMP_HINT}.`);
    // Not this pull request's doing: the publish run on main reports it.
    else if (s.kind === 'settled' && needsRebuild(s, sdkRebuild)) log(`Note: ${releaseTag(s.id, s.version)} is built for SDK ${s.listed.sdk}; ${rebuildHint(sdkRebuild)}.`);
  }
  if (index !== null && branchText(git, dir, 'HEAD') !== indexText(index)) log(`Note: this commit's ${MARKETPLACE_INDEX_FILE} is older than the ${MARKETPLACE_INDEX_TAG} release's; --stamp refreshes it.`);
}

/** A pull request's branch: stamps changed plugins and refreshes the marketplace.json copy, in one commit there. */
async function stamp(options: ReleaseChangedOptions, dir: string, workDir: string, result: ReleaseChangedResult): Promise<void> {
  const { repo, dryRun, only, sdkRebuild, gh = runGh, git = runGit, check = checkPlugin, log = console.log } = options;
  preflightBranch(git, dir, repo);
  const store: IndexStore = { fallback: () => branchIndex(git, dir), target: gitOut(git, dir, ['rev-parse', MAIN]) };
  const index = await readIndex(gh, repo, store, workDir);
  const states = readStates(git, dir, index, only, 'HEAD');
  for (const s of states) log(summary(s));
  for (const s of states) if (s.kind === 'broken') result.failed.push(`${s.id}: ${s.reason}`);
  const planned = states.flatMap((s) => (s.kind === 'settled' && (s.changed || needsRebuild(s, sdkRebuild)) ? [{ id: s.id, version: raisedVersion(s.version, s.changed ?? ['patch']) }] : []));
  for (const p of planned) log(`${dryRun ? 'Would stamp' : 'Stamping'} ${releaseTag(p.id, p.version)}`);

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
  if (!passed || dryRun) return;
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
    if (paths.length) gitOut(git, dir, ['checkout', '--', ...paths]);
    throw err;
  }
  // Hosts that read only the default branch's file see releases once a pull request carries this copy to main.
  const synced = index !== null && branchText(git, dir, 'HEAD') !== indexText(index);
  if (synced) {
    writeFileSync(join(dir, MARKETPLACE_INDEX_FILE), indexText(index));
    paths.push(MARKETPLACE_INDEX_FILE);
  }
  if (!paths.length) return void log('Nothing to stamp, and the marketplace.json copy is current.');
  gitOut(git, dir, ['add', '--', ...paths]);
  const tags = planned.map((p) => releaseTag(p.id, p.version));
  const subject = tags.length ? `${STAMP_PREFIX}${tags.join(', ')}${synced ? `; sync ${MARKETPLACE_INDEX_FILE}` : ''}` : SYNC_SUBJECT;
  gitOut(git, dir, ['commit', '-m', subject, '--', ...paths]);
  result.stamped.push(...tags);
  log(`Committed "${subject}"; push the branch with your pull request.`);
}

/** CLI entry (scripts/runTs.mjs). */
export async function main(args: string[]): Promise<number> {
  const valued = ['--repo', '--only'];
  const flags = ['--dry-run', '--sdk-rebuild', '--stamp', '--check'];
  const value = (flag: string): string | undefined => {
    const at = args.indexOf(flag);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const values = new Set(valued.map((f) => args.indexOf(f) + 1).filter((i) => i > 0));
  const dirs = args.filter((a, i) => !a.startsWith('--') && !values.has(i));
  const unknown = args.filter((a, i) => a.startsWith('--') && !values.has(i) && ![...valued, ...flags].includes(a));
  const repo = value('--repo');
  const onlyArg = value('--only');
  const badValue = valued.some((f) => args.includes(f) && (!value(f) || value(f)!.startsWith('--')));
  const both = args.includes('--stamp') && args.includes('--check');
  if (dirs.length !== 1 || !repo || badValue || unknown.length || both) {
    console.error(USAGE);
    return 1;
  }
  const mode: ReleaseMode = args.includes('--stamp') ? 'stamp' : args.includes('--check') ? 'check' : 'publish';
  const only = onlyArg?.split(',').map((s) => s.trim()).filter(Boolean);
  const r = await releaseChanged({ repoDir: dirs[0]!, repo, mode, dryRun: args.includes('--dry-run'), only, sdkRebuild: args.includes('--sdk-rebuild') });
  if (mode === 'publish') console.log(`Released: ${r.released.join(', ') || 'none'}`);
  if (mode === 'stamp') console.log(`Stamped: ${r.stamped.join(', ') || 'none'}`);
  if (r.failed.length) console.error(`${mode === 'publish' ? 'Not released' : mode === 'stamp' ? 'Not stamped' : 'Not ready to merge'}:\n${r.failed.join('\n')}`);
  return r.failed.length ? 1 : 0;
}
