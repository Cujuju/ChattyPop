// Publishes one plugin version to its marketplace repo (docs/plugin-architecture.md §16, Releasing): ensureReleased
// drives tag, release, asset and marketplace.json listing to done from whatever partial state an earlier run left,
// deleting or replacing nothing but a failed upload's empty placeholder. GitHub calls go through `gh`, git calls
// through `git`, both injectable.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { create, extract } from 'tar';
import { INSTALLED_MANIFEST_FILE, compareVersions, parseInstalledManifest, type InstalledManifest } from '../src/shared/installedPlugins';
import { MARKETPLACE_FORMAT, MARKETPLACE_INDEX_FILE, parseMarketplaceIndex, type MarketplaceRelease } from '../src/shared/marketplace';
import { releaseTag } from './pluginReleaseState';

/** Runs `gh` with `args` (and `input` on stdin). */
export type Gh = (args: readonly string[], input?: string) => Promise<{ code: number; stdout: string; stderr: string }>;

export const runGh: Gh = (args, input) =>
  new Promise((done, fail) => {
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => (stdout += b));
    child.stderr.on('data', (b: Buffer) => (stderr += b));
    child.on('error', fail);
    child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input ?? '');
  });

/** Runs `git` with `args` in `dir`. */
export type Git = (dir: string, args: readonly string[]) => { code: number; stdout: string; stderr: string };

export const runGit: Git = (dir, args) => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (r.error) throw r.error;
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
};

/** How many times a marketplace.json write is tried when another write lands between its read and its write. */
const INDEX_WRITE_ATTEMPTS = 3;
const NOT_FOUND = /HTTP 404/;
const CONFLICT = /HTTP 409/;
/** `gh release view`'s answer for a tag with no release, draft or published. */
const NO_RELEASE = /release not found/i;

const failed = (what: string, r: { code: number; stderr: string }): Error => new Error(`${what} failed: ${r.stderr.trim() || `exit ${r.code}`}`);

/** `gh api` output; null on 404 only when `missingOk`. Any other failure throws. */
async function ghApi(gh: Gh, args: readonly string[], missingOk: boolean): Promise<string | null> {
  const r = await gh(['api', ...args]);
  if (r.code === 0) return r.stdout;
  if (missingOk && NOT_FOUND.test(r.stderr)) return null;
  throw failed(`gh api ${args.join(' ')}`, r);
}

/** gh with `args`, throwing its error. */
async function ghRun(gh: Gh, args: readonly string[]): Promise<void> {
  const r = await gh(args);
  if (r.code !== 0) throw failed(`gh ${args[0]} ${args[1]}`, r);
}

/**
 * marketplace.json (`raw`, null when the repo has none) with `release` added to plugin `manifest.id`: newest first,
 * refusing a version already listed. The plugin's name and description follow its newest release; every other field
 * of the file stays as it was.
 */
export function withRelease(raw: unknown, manifest: Pick<InstalledManifest, 'id' | 'name' | 'description'>, release: MarketplaceRelease): Record<string, unknown> {
  const index = structuredClone((raw ?? { format: MARKETPLACE_FORMAT, plugins: [] }) as Record<string, unknown>);
  const parsed = parseMarketplaceIndex(index);
  const plugins = index['plugins'] as Record<string, unknown>[];
  const at = parsed.plugins.findIndex((p) => p.id === manifest.id);
  if (at < 0) {
    plugins.push({ id: manifest.id, name: manifest.name, description: manifest.description, releases: [release] });
    return index;
  }
  if (parsed.plugins[at]!.releases.some((r) => r.version === release.version)) throw new Error(`${MARKETPLACE_INDEX_FILE} already lists ${manifest.id} ${release.version}.`);
  const entry = plugins[at]!;
  const releases = [...(entry['releases'] as MarketplaceRelease[]), release].sort((a, b) => compareVersions(b.version, a.version));
  entry['releases'] = releases;
  if (releases[0] === release) Object.assign(entry, { name: manifest.name, description: manifest.description });
  return index;
}

const sha256Of = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Packs `dir`'s contents (plugin.json at the archive root, no top-level folder) into `file`; returns its sha256. */
export async function pack(dir: string, file: string): Promise<string> {
  await create({ gzip: true, portable: true, cwd: dir, file }, readdirSync(dir).sort());
  return sha256Of(file);
}

/** The plugin.json inside a release asset. */
async function assetManifest(file: string, dir: string): Promise<InstalledManifest> {
  mkdirSync(dir, { recursive: true });
  await extract({ file, cwd: dir }, [INSTALLED_MANIFEST_FILE]);
  return parseInstalledManifest(JSON.parse(readFileSync(join(dir, INSTALLED_MANIFEST_FILE), 'utf8')));
}

export const assetName = (id: string, version: string): string => `${id}-${version}.tar.gz`;

/** A built release asset: the archive, its plugin.json, and the release notes recording what built it. */
export interface BuiltAsset {
  file: string;
  manifest: InstalledManifest;
  notes: string;
}

export interface EnsureOptions {
  repo: string;
  id: string;
  version: string;
  /** The commit the release's tag is (or must be) at. */
  target: string;
  /** Builds the asset from `target` into `workDir`; called only when the release lacks it. */
  buildAsset: (workDir: string) => Promise<BuiltAsset>;
  /** An empty folder for the build and the downloaded asset. */
  workDir: string;
  gh?: Gh;
  log?: (line: string) => void;
}

interface ReleaseView {
  isDraft: boolean;
  targetCommitish: string;
  /** `state` is `uploaded` once complete; a failed upload leaves a `starter` placeholder without content. */
  assets: { name: string; state: string }[];
}

const UPLOADED = 'uploaded';

/** The commit tag `tag` points at on `repo` (an annotated tag peeled), or null when there is none. */
async function tagCommit(gh: Gh, repo: string, tag: string): Promise<string | null> {
  const ref = await ghApi(gh, [`repos/${repo}/git/ref/tags/${tag}`], true);
  if (ref === null) return null;
  let { object } = JSON.parse(ref) as { object: { type: string; sha: string } };
  if (object.type === 'tag') object = (JSON.parse((await ghApi(gh, [`repos/${repo}/git/tags/${object.sha}`], false))!) as { object: typeof object }).object;
  if (object.type !== 'commit') throw new Error(`Tag ${tag} on ${repo} points at a ${object.type}, not a commit.`);
  return object.sha;
}

/** The release for `tag`, draft or published, or null when there is none. */
async function viewRelease(gh: Gh, repo: string, tag: string): Promise<ReleaseView | null> {
  const r = await gh(['release', 'view', tag, '--repo', repo, '--json', 'isDraft,targetCommitish,assets']);
  if (r.code === 0) return JSON.parse(r.stdout) as ReleaseView;
  if (NO_RELEASE.test(r.stderr)) return null;
  throw failed(`gh release view ${tag}`, r);
}

/**
 * Lists `entry` in `repo`'s marketplace.json, at the read sha; a conflicting write is re-read and retried. True when it
 * wrote, false when the version was listed already (with the same tag and sha256, else it throws).
 */
export async function listRelease(gh: Gh, repo: string, manifest: Pick<InstalledManifest, 'id' | 'name' | 'description'>, entry: MarketplaceRelease): Promise<boolean> {
  const path = `repos/${repo}/contents/${MARKETPLACE_INDEX_FILE}`;
  for (let attempt = 1; ; attempt++) {
    const current = await ghApi(gh, [path], true);
    const file = current === null ? null : (JSON.parse(current) as { content: string; sha: string });
    const raw = file ? (JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')) as unknown) : null;
    const listed = raw === null ? undefined : parseMarketplaceIndex(raw).plugins.find((p) => p.id === manifest.id)?.releases.find((r) => r.version === entry.version);
    if (listed) {
      if (listed.tag !== entry.tag || listed.sha256 !== entry.sha256) throw new Error(`${MARKETPLACE_INDEX_FILE} lists ${manifest.id} ${entry.version} as ${listed.tag} ${listed.sha256}, not the published ${entry.tag} ${entry.sha256}.`);
      return false;
    }
    const content = Buffer.from(`${JSON.stringify(withRelease(raw, manifest, entry), null, 2)}\n`).toString('base64');
    const body = { message: `release: ${entry.tag}`, content, ...(file ? { sha: file.sha } : {}) };
    const r = await gh(['api', '-X', 'PUT', path, '--input', '-'], JSON.stringify(body));
    if (r.code === 0) return true;
    if (!CONFLICT.test(r.stderr) || attempt >= INDEX_WRITE_ATTEMPTS) throw failed(`Writing ${MARKETPLACE_INDEX_FILE}`, r);
  }
}

export interface Ensured {
  tag: string;
  sha256: string;
  sdk: string;
  /** Whether this call added the listing (false: listed already). */
  listed: boolean;
}

/** Drives `id` `version` to a published release with its asset at `target`, listed in marketplace.json. */
export async function ensureReleased({ repo, id, version, target, buildAsset, workDir, gh = runGh, log = console.log }: EnsureOptions): Promise<Ensured> {
  const tag = releaseTag(id, version);
  const name = assetName(id, version);
  const tagAt = await tagCommit(gh, repo, tag);
  if (tagAt !== null && tagAt !== target) throw new Error(`Tag ${tag} on ${repo} is at ${tagAt}, not its release target ${target}.`);
  const before = await viewRelease(gh, repo, tag);
  // Without a tag, a draft's target becomes the tag's commit when it is published.
  if (before && tagAt === null && before.targetCommitish !== target) throw new Error(`Draft ${tag} on ${repo} targets ${before.targetCommitish}, not ${target}.`);
  const build = async (): Promise<BuiltAsset> => {
    const built = await buildAsset(join(workDir, 'build'));
    if (built.manifest.id !== id || built.manifest.version !== version) throw new Error(`Built ${built.manifest.id} ${built.manifest.version}, not ${id} ${version}.`);
    return built;
  };
  if (!before) {
    const built = await build();
    const at = tagAt === null ? ['--target', target] : ['--verify-tag'];
    await ghRun(gh, ['release', 'create', tag, built.file, '--repo', repo, ...at, '--title', `${built.manifest.name} ${version}`, '--notes', built.notes]);
    log(`Released ${tag} on ${repo}`);
  } else {
    const asset = before.assets.find((a) => a.name === name);
    // The only thing ever deleted: a failed upload's placeholder, which holds no content (GitHub's documented remedy).
    if (asset && asset.state !== UPLOADED) {
      await ghRun(gh, ['release', 'delete-asset', tag, name, '--repo', repo, '--yes']);
      log(`Removed ${tag}'s incomplete ${name} (${asset.state})`);
    }
    if (asset?.state !== UPLOADED) {
      await ghRun(gh, ['release', 'upload', tag, (await build()).file, '--repo', repo]);
      log(`Uploaded ${name} to ${tag}`);
    }
  }
  const after = await viewRelease(gh, repo, tag);
  if (!after) throw new Error(`gh reports no release ${tag} on ${repo} after creating it.`);
  if (after.isDraft) {
    await ghRun(gh, ['release', 'edit', tag, '--repo', repo, '--draft=false']);
    log(`Published ${tag}`);
  }
  if ((await tagCommit(gh, repo, tag)) !== target) throw new Error(`Published ${tag}, but its tag is not at ${target}.`);

  const downloads = join(workDir, 'published');
  await ghRun(gh, ['release', 'download', tag, '--repo', repo, '--pattern', name, '--dir', downloads]);
  const file = join(downloads, name);
  const manifest = await assetManifest(file, join(downloads, 'manifest'));
  if (manifest.id !== id || manifest.version !== version) throw new Error(`${tag}'s asset holds ${manifest.id} ${manifest.version}, not ${id} ${version}.`);
  const entry: MarketplaceRelease = { version, tag, asset: name, sha256: sha256Of(file), sdk: manifest.sdk };
  const listed = await listRelease(gh, repo, manifest, entry);
  log(listed ? `Listed ${id} ${version} in ${repo}/${MARKETPLACE_INDEX_FILE}` : `${id} ${version} was listed already`);
  return { tag, sha256: entry.sha256, sdk: entry.sdk, listed };
}
