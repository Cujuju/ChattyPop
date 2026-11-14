// Compares manifest version L at a commit (origin/main, or a pull request's branch) with N, the newest version the index lists.
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
/** A release-intent commit's subject: this, then the tags it stamped (`a-v1.0.1, b-v1.1.0`). Releases pushed these to main before versions were stamped in pull requests; one still unpublished is finished at its commit. Never title a commit or a pull request this way. */
export const INTENT_PREFIX = 'chore(release): ';
const INTENT_SEPARATOR = ', ';

export type Bump = 'minor' | 'patch';

export type PluginState =
  /** L == N means released. Changed content accumulates ordered commit bumps; unchanged content returns null. */
  | { id: string; kind: 'settled'; version: string; listed: MarketplaceRelease; changed: Bump[] | null }
  /** Lowest unpublished release intent and its target commit. */
  | { id: string; kind: 'pending'; version: string; target: string; changedSinceTarget: boolean }
  /** Unlisted or raised manifest version without an intent: released at L. Its target is L's tag when an interrupted release made one, else null (the commit being released). */
  | { id: string; kind: 'unstamped'; version: string; target: string | null; changedSinceTarget: boolean }
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

/** Resolves N’s tag on main and verifies its descriptor ID and version. */
function listedCommit(git: Git, dir: string, id: string, listed: MarketplaceRelease): string {
  const r = git(dir, ['rev-parse', '--verify', '--quiet', `refs/tags/${listed.tag}^{commit}`]);
  if (r.code !== 0) throw new Error(`its newest listed release ${listed.version} has no tag ${listed.tag}.`);
  const commit = r.stdout.trim();
  if (!gitTest(git, dir, ['merge-base', '--is-ancestor', commit, MAIN])) throw new Error(`tag ${listed.tag} is not on main.`);
  const at = manifestAt(git, dir, commit, id);
  if (at.id !== id || at.version !== listed.version) throw new Error(`tag ${listed.tag}'s descriptor is ${at.id} ${at.version}, not ${id} ${listed.version}.`);
  return commit;
}

/** Counts non-merge commits since the prior release up to `rev`: features increment minor. Unchanged content returns null; merge-only changes increment patch once. */
function changedSince(git: Git, dir: string, id: string, since: string, rev: string): Bump[] | null {
  const folder = `${PLUGINS_DIR}/${id}`;
  if (gitTest(git, dir, ['diff', '--quiet', since, rev, '--', folder])) return null;
  const log = gitOut(git, dir, ['log', '--no-merges', '--topo-order', '--reverse', '--format=%s', `${since}..${rev}`, '--', folder]);
  const bumps = log ? log.split('\n').map((s): Bump => (FEATURE_SUBJECT.test(s) ? 'minor' : 'patch')) : [];
  return bumps.length ? bumps : ['patch'];
}

/** The plugin ids at `rev`: folders with a shared entry. */
export function pluginIds(git: Git, dir: string, rev = MAIN): string[] {
  const files = gitOut(git, dir, ['ls-tree', '-r', '--name-only', rev, '--', PLUGINS_DIR]).split('\n');
  const entry = new RegExp(`^${PLUGINS_DIR}/([^/]+)/${SHARED_ENTRY}$`);
  return files.flatMap((f) => entry.exec(f)?.[1] ?? []).sort();
}

/** `rev`'s marketplace.json (parsed; null when it has none): the index until the index release exists, and a copy of it after. */
export function branchIndex(git: Git, dir: string, rev = MAIN): unknown {
  const has = gitOut(git, dir, ['ls-tree', '--name-only', rev, '--', MARKETPLACE_INDEX_FILE]) !== '';
  return has ? (JSON.parse(gitOut(git, dir, ['show', `${rev}:${MARKETPLACE_INDEX_FILE}`])) as unknown) : null;
}

/** The commit of `id`'s tag for `version` (fetched), which must be on MAIN and hold that version; null when there is no tag. */
function tagTarget(git: Git, dir: string, id: string, version: string): string | null {
  const tag = releaseTag(id, version);
  const r = git(dir, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]);
  if (r.code !== 0) return null;
  const commit = r.stdout.trim();
  if (!gitTest(git, dir, ['merge-base', '--is-ancestor', commit, MAIN])) throw new Error(`tag ${tag} is not on main.`);
  const at = manifestAt(git, dir, commit, id);
  if (at.id !== id || at.version !== version) throw new Error(`tag ${tag}'s descriptor is ${at.id} ${at.version}, not ${id} ${version}.`);
  return commit;
}

/** Each plugin's state at `rev` (all, or `only`) against `rawIndex` (null: none yet), as of the last fetch. Listed tags and intents are read on MAIN. */
export function readStates(git: Git, dir: string, rawIndex: unknown, only?: readonly string[], rev = MAIN): PluginState[] {
  const all = pluginIds(git, dir, rev);
  const unknown = (only ?? []).filter((id) => !all.includes(id));
  if (unknown.length) throw new Error(`No plugin folder at ${rev === MAIN ? 'main' : rev} for ${unknown.join(', ')}.`);
  const index = parseMarketplaceIndex(rawIndex ?? { format: MARKETPLACE_FORMAT, plugins: [] });
  const intents = intentCommits(git, dir);
  return (only ?? all).map((id): PluginState => {
    try {
      const { id: named, version } = manifestAt(git, dir, rev, id);
      if (named !== id) throw new Error(`its descriptor's id is ${named}.`);
      if (!VERSION_PATTERN.test(version)) throw new Error(`its version ${version} is not x.y.z.`);
      /** Whether the folder changed after `target`, which fixes `fixed`'s content, without `rev` raising its literal past `fixed`. */
      const editedSince = (target: string, fixed: string): boolean =>
        compareVersions(version, fixed) <= 0 && !gitTest(git, dir, ['diff', '--quiet', target, rev, '--', `${PLUGINS_DIR}/${id}`]);
      const listed = index.plugins.find((p) => p.id === id)?.releases[0];
      const since = listed ? listedCommit(git, dir, id, listed) : null;
      const order = listed ? compareVersions(version, listed.version) : 1;
      if (order < 0) throw new Error(`its version ${version} is below its newest listed release ${listed!.version}.`);
      // Completes every intent above N, lowest-first, including intents skipped by a manually increased version literal.
      const unfinished = intendedVersions(intents, id).filter((v) => !listed || compareVersions(v, listed.version) > 0);
      if (unfinished.length) {
        const intended = unfinished[0]!;
        const tag = releaseTag(id, intended);
        const targets = intents.get(tag)!;
        if (targets.length > 1) throw new Error(`${targets.length} release-intent commits name ${tag}: ${targets.join(', ')}.`);
        const atTarget = manifestAt(git, dir, targets[0]!, id);
        if (atTarget.version !== intended) throw new Error(`its intent commit ${targets[0]} holds version ${atTarget.version}, not ${intended}.`);
        return { id, kind: 'pending', version: intended, target: targets[0]!, changedSinceTarget: editedSince(targets[0]!, intended) };
      }
      if (order === 0) return { id, kind: 'settled', version, listed: listed!, changed: changedSince(git, dir, id, since!, rev) };
      const target = tagTarget(git, dir, id, version);
      // The tag fixes L's content: later edits to the folder need a version of their own.
      return { id, kind: 'unstamped', version, target, changedSinceTarget: target !== null && editedSince(target, version) };
    } catch (err) {
      return { id, kind: 'broken', reason: (err as Error).message };
    }
  });
}
