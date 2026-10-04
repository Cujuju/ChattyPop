// Each plugin's release state in a plugin repo (docs/plugin-architecture.md §16, Releasing), read from git: its manifest
// version on origin/main (L) against its newest release in marketplace.json there (N).
import { FEATURE_SUBJECT } from '../appVersion';
import { SHARED_ENTRY } from '../src/main/pluginBuild/descriptor';
import { VERSION_PATTERN, compareVersions } from '../src/shared/installedPlugins';
import { MARKETPLACE_FORMAT, MARKETPLACE_INDEX_FILE, MARKETPLACE_PLUGINS_DIR, parseMarketplaceIndex, type MarketplaceRelease } from '../src/shared/marketplace';
import type { Git } from './pluginRelease';
import { manifestVersion } from './pluginScan/manifest';

/** The branch releases come from, as fetched. */
export const MAIN = 'origin/main';
/** A plugin repo's plugin folders, each named by its id. */
export const PLUGINS_DIR = MARKETPLACE_PLUGINS_DIR;
/** A release-intent commit's subject: this, then the tags it stamped (`a-v1.0.1, b-v1.1.0`). */
export const INTENT_PREFIX = 'chore(release): ';
const INTENT_SEPARATOR = ', ';

export type Bump = 'minor' | 'patch';

export type PluginState =
  /** L == N: released. `changed`: one bump per commit to its folder since N's tag, oldest first; null when unchanged. */
  | { id: string; kind: 'settled'; version: string; listed: MarketplaceRelease; changed: Bump[] | null }
  /** An intent commit names a version above N (or any, unlisted): the lowest is to be published at `target`. */
  | { id: string; kind: 'pending'; version: string; target: string }
  /** L > N (or unlisted) and no intent above N: a new plugin, or a hand-raised version, to stamp at L. */
  | { id: string; kind: 'unstamped'; version: string }
  /** Its state contradicts the contract; nothing is done for it until a person fixes it. */
  | { id: string; kind: 'broken'; reason: string };

export const releaseTag = (id: string, version: string): string => `${id}-v${version}`;
export const intentSubject = (tags: readonly string[]): string => `${INTENT_PREFIX}${tags.join(INTENT_SEPARATOR)}`;
export const sharedPath = (id: string): string => `${PLUGINS_DIR}/${id}/${SHARED_ENTRY}`;

/** `version` raised by `bump`: minor resets the patch. */
export function nextVersion(version: string, bump: Bump): string {
  const m = VERSION_PATTERN.exec(version);
  if (!m) throw new Error(`${version} is not x.y.z.`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return bump === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

/** `version` raised by each bump in turn. */
export const raisedVersion = (version: string, bumps: readonly Bump[]): string => bumps.reduce(nextVersion, version);

/** git's trimmed output in `dir`; throws its error. */
export function gitOut(git: Git, dir: string, args: readonly string[]): string {
  const r = git(dir, args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r.stdout.trim();
}

/** Whether `args` exits 0 (true) or 1 (false); throws on anything else. */
function gitTest(git: Git, dir: string, args: readonly string[]): boolean {
  const r = git(dir, args);
  if (r.code > 1) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.code === 0;
}

/** The manifest id and version in `id`'s shared entry at `rev`. */
function manifestAt(git: Git, dir: string, rev: string, id: string): { id: string; version: string } {
  const rel = sharedPath(id);
  return manifestVersion({ rel, text: gitOut(git, dir, ['show', `${rev}:${rel}`]) });
}

/** Release-intent commits on MAIN, by each tag their subject names. */
function intentCommits(git: Git, dir: string): Map<string, string[]> {
  const byTag = new Map<string, string[]>();
  const log = gitOut(git, dir, ['log', '--fixed-strings', `--grep=${INTENT_PREFIX}`, '--format=%H%x09%s', MAIN]);
  for (const line of log ? log.split('\n') : []) {
    const [hash, subject] = line.split('\t') as [string, string];
    if (!subject.startsWith(INTENT_PREFIX)) continue;
    for (const tag of subject.slice(INTENT_PREFIX.length).split(INTENT_SEPARATOR)) byTag.set(tag, [...(byTag.get(tag) ?? []), hash]);
  }
  return byTag;
}

/** The versions of id that release-intent commits name, lowest first. */
function intendedVersions(intents: Map<string, string[]>, id: string): string[] {
  const prefix = releaseTag(id, '');
  return [...intents.keys()].flatMap((tag) => (tag.startsWith(prefix) && VERSION_PATTERN.test(tag.slice(prefix.length)) ? [tag.slice(prefix.length)] : [])).sort(compareVersions);
}

/** Throws unless N's tag is a commit on MAIN whose descriptor is `id` at N. Returns that commit. */
function listedCommit(git: Git, dir: string, id: string, listed: MarketplaceRelease): string {
  const r = git(dir, ['rev-parse', '--verify', '--quiet', `refs/tags/${listed.tag}^{commit}`]);
  if (r.code !== 0) throw new Error(`its newest listed release ${listed.version} has no tag ${listed.tag}.`);
  const commit = r.stdout.trim();
  if (!gitTest(git, dir, ['merge-base', '--is-ancestor', commit, MAIN])) throw new Error(`tag ${listed.tag} is not on main.`);
  const at = manifestAt(git, dir, commit, id);
  if (at.id !== id || at.version !== listed.version) throw new Error(`tag ${listed.tag}'s descriptor is ${at.id} ${at.version}, not ${id} ${listed.version}.`);
  return commit;
}

/**
 * The bumps `id`'s folder needs since `since`, as appVersion counts: per non-merge commit, oldest first, `feat` a minor.
 * Null when its content is the same; one patch when only a merge changed it.
 */
function changedSince(git: Git, dir: string, id: string, since: string): Bump[] | null {
  const folder = `${PLUGINS_DIR}/${id}`;
  if (gitTest(git, dir, ['diff', '--quiet', since, MAIN, '--', folder])) return null;
  const log = gitOut(git, dir, ['log', '--no-merges', '--topo-order', '--reverse', '--format=%s', `${since}..${MAIN}`, '--', folder]);
  const bumps = log ? log.split('\n').map((s): Bump => (FEATURE_SUBJECT.test(s) ? 'minor' : 'patch')) : [];
  return bumps.length ? bumps : ['patch'];
}

/** The plugin ids on MAIN: folders with a shared entry. */
export function pluginIds(git: Git, dir: string): string[] {
  const files = gitOut(git, dir, ['ls-tree', '-r', '--name-only', MAIN, '--', PLUGINS_DIR]).split('\n');
  const entry = new RegExp(`^${PLUGINS_DIR}/([^/]+)/${SHARED_ENTRY}$`);
  return files.flatMap((f) => entry.exec(f)?.[1] ?? []).sort();
}

/** Each plugin's state on MAIN (all, or `only`), as of the last fetch. */
export function readStates(git: Git, dir: string, only?: readonly string[]): PluginState[] {
  const all = pluginIds(git, dir);
  const unknown = (only ?? []).filter((id) => !all.includes(id));
  if (unknown.length) throw new Error(`No plugin folder on main for ${unknown.join(', ')}.`);
  const hasIndex = gitOut(git, dir, ['ls-tree', '--name-only', MAIN, '--', MARKETPLACE_INDEX_FILE]) !== '';
  const index = parseMarketplaceIndex(hasIndex ? JSON.parse(gitOut(git, dir, ['show', `${MAIN}:${MARKETPLACE_INDEX_FILE}`])) : { format: MARKETPLACE_FORMAT, plugins: [] });
  const intents = intentCommits(git, dir);
  return (only ?? all).map((id): PluginState => {
    try {
      const { id: named, version } = manifestAt(git, dir, MAIN, id);
      if (named !== id) throw new Error(`its descriptor's id is ${named}.`);
      if (!VERSION_PATTERN.test(version)) throw new Error(`its version ${version} is not x.y.z.`);
      const listed = index.plugins.find((p) => p.id === id)?.releases[0];
      const since = listed ? listedCommit(git, dir, id, listed) : null;
      const order = listed ? compareVersions(version, listed.version) : 1;
      if (order < 0) throw new Error(`its version ${version} is below its newest listed release ${listed!.version}.`);
      // Every intent above N is finished, lowest first, even one a later hand-raised literal passed over.
      const unfinished = intendedVersions(intents, id).filter((v) => !listed || compareVersions(v, listed.version) > 0);
      if (unfinished.length) {
        const intended = unfinished[0]!;
        const tag = releaseTag(id, intended);
        const targets = intents.get(tag)!;
        if (targets.length > 1) throw new Error(`${targets.length} release-intent commits name ${tag}: ${targets.join(', ')}.`);
        const atTarget = manifestAt(git, dir, targets[0]!, id);
        if (atTarget.version !== intended) throw new Error(`its intent commit ${targets[0]} holds version ${atTarget.version}, not ${intended}.`);
        return { id, kind: 'pending', version: intended, target: targets[0]! };
      }
      if (order === 0) return { id, kind: 'settled', version, listed: listed!, changed: changedSince(git, dir, id, since!) };
      return { id, kind: 'unstamped', version };
    } catch (err) {
      return { id, kind: 'broken', reason: (err as Error).message };
    }
  });
}
