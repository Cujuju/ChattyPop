// Plugin release tests' world: a real plugin repo (a bare "GitHub" remote and the clone a release runs in) and a fake
// gh holding releases and serving marketplace.json from the bare repo, with failures injectable per call.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { INSTALLED_FORMAT, INSTALLED_MANIFEST_FILE, PLUGIN_SDK_VERSION, type InstalledManifest } from '@shared/installedPlugins';
import { pack, runGit, withRelease, type BuiltAsset, type Gh, type Git } from '../scripts/pluginRelease';
import { gitOut } from '../scripts/pluginReleaseState';
import { tempDir } from './helpers';

export const REPO = 'owner/plugins';
/** A test drives a few dozen real git commands; each takes a tenth of a second or more on Windows. */
export const GIT_TEST_TIMEOUT_MS = 60_000;
const ORIGIN_URL = `https://github.com/${REPO}.git`;
const IDENTITY = ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com'];

/** A plugin's shared entry, in the inline manifest shape. */
export const sharedSource = (id: string, version: string): string =>
  `import { definePlugin } from '@plugin-sdk/shared';\n\nexport const plugin = definePlugin({\n  manifest: { id: '${id}', name: '${id.toUpperCase()}', version: '${version}', description: 'Fixture ${id}.' },\n});\nexport default plugin;\n`;
export const sharedFile = (id: string): string => `plugins/${id}/shared/index.ts`;

/** Real git, except that the clone's origin reads as the GitHub repo (it is the bare repo on disk). */
export const git: Git = (dir, args) => (args.join(' ') === 'remote get-url origin' ? { code: 0, stdout: `${ORIGIN_URL}\n`, stderr: '' } : runGit(dir, args));
export const out = (dir: string, ...args: string[]): string => gitOut(runGit, dir, args);

export interface PluginRepo {
  bare: string;
  /** The clone a release runs in. */
  clone: string;
  /** Another person's clone: commits there are pushed to main. */
  other: string;
}

/** Writes `files` in `dir`, commits them (`subject`), pushes to main; the commit. */
export function commit(dir: string, files: Record<string, string>, subject: string, push = true): string {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  if (Object.keys(files).length) out(dir, 'add', '--', ...Object.keys(files));
  out(dir, ...IDENTITY, 'commit', '--allow-empty', '-m', subject);
  if (push) out(dir, 'push', 'origin', 'HEAD:main');
  return out(dir, 'rev-parse', 'HEAD');
}

/** A bare repo whose main holds `plugins` (id → version), and two clones of it. */
export function pluginRepo(plugins: Record<string, string>): PluginRepo {
  const root = tempDir();
  const bare = join(root, 'remote.git');
  out(root, 'init', '--bare', '-b', 'main', bare);
  const clone = join(root, 'clone');
  out(root, 'clone', '-q', bare, clone);
  out(clone, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  // The release's own commits (its intent commit) take the clone's identity.
  out(clone, 'config', 'user.name', 'Release bot');
  out(clone, 'config', 'user.email', 'bot@example.com');
  commit(clone, { 'README.md': 'Plugins.\n', ...Object.fromEntries(Object.entries(plugins).map(([id, v]) => [sharedFile(id), sharedSource(id, v)])) }, 'chore: plugins');
  const other = join(root, 'other');
  out(root, 'clone', '-q', bare, other);
  return { bare, clone, other };
}

/** Brings `dir` up to the remote's main. */
export const pull = (dir: string): void => void out(dir, 'pull', '-q', '--ff-only', 'origin', 'main');

/** Records id ersion as released at t, as an earlier run left it: its tag, and a listing commit on main. */
export function listed(repo: PluginRepo, id: string, version: string, at: string, sdk = PLUGIN_SDK_VERSION): void {
  const tag = `${id}-v${version}`;
  out(repo.bare, 'tag', tag, at);
  pull(repo.other);
  const file = join(repo.other, 'marketplace.json');
  const raw = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as unknown) : null;
  const next = withRelease(raw, manifestOf(id, version, sdk), { version, tag, asset: `${id}-${version}.tar.gz`, sha256: 'a'.repeat(64), sdk });
  commit(repo.other, { 'marketplace.json': `${JSON.stringify(next, null, 2)}\n` }, `release: ${tag}`);
  pull(repo.clone);
  out(repo.clone, 'fetch', '-q', '--tags', 'origin');
}

/** A minimal plugin.json for `id` `version`, built for `sdk`. */
export const manifestOf = (id: string, version: string, sdk = PLUGIN_SDK_VERSION): InstalledManifest => ({
  format: INSTALLED_FORMAT, id, name: id.toUpperCase(), version, description: `Fixture ${id}.`, sdk,
  node: { shared: 'node/shared.js' }, browser: { shared: 'browser/shared.js', styles: [] }, hostImports: {},
});

/** A release asset for `id` `version` built for `sdk`, packed into `workDir`. */
export async function fakeAsset(workDir: string, id: string, version: string, sdk = PLUGIN_SDK_VERSION): Promise<BuiltAsset> {
  const dir = join(workDir, 'out');
  mkdirSync(dir, { recursive: true });
  const manifest = manifestOf(id, version, sdk);
  writeFileSync(join(dir, INSTALLED_MANIFEST_FILE), JSON.stringify(manifest));
  const file = join(workDir, `${id}-${version}.tar.gz`);
  await pack(dir, file);
  return { file, manifest, notes: `${manifest.description}\n\nBuilt by the test.` };
}

interface FakeRelease {
  isDraft: boolean;
  targetCommitish: string;
  /** Asset name → its stored copy. */
  assets: Map<string, string>;
  /** Assets a failed upload left as GitHub's empty `starter` placeholders. */
  starters?: Set<string>;
}

type Reply = { code: number; stdout?: string; stderr?: string };

export interface FakeGh {
  gh: Gh;
  releases: Map<string, FakeRelease>;
  /** Every call's args joined with spaces. */
  calls: string[];
  /** Replies `reply` instead of running the next `times` calls starting with `prefix`. */
  failNext(prefix: string, reply: Reply, times?: number): void;
  /** Stores `file` as an asset of `tag`'s release. */
  addAsset(tag: string, file: string): void;
}

const notFound: Reply = { code: 1, stderr: 'gh: Not Found (HTTP 404)' };
const flag = (args: readonly string[], name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

/** A gh over `bare`: releases in memory, tags and marketplace.json in the bare repo. */
export function fakeGh(bare: string): FakeGh {
  const store = tempDir();
  const scratch = join(tempDir(), 'gh');
  out(dirname(scratch), 'clone', '-q', bare, scratch);
  const releases = new Map<string, FakeRelease>();
  const calls: string[] = [];
  const failures: { prefix: string; reply: Reply; times: number }[] = [];
  const tagSha = (tag: string): string | null => {
    const r = runGit(bare, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]);
    return r.code === 0 ? r.stdout.trim() : null;
  };
  const addAsset = (tag: string, file: string): void => {
    const copy = join(store, `${tag}-${basename(file)}`);
    copyFileSync(file, copy);
    releases.get(tag)!.assets.set(basename(file), copy);
  };
  const index = (): { content: string; sha: string } | null => {
    const sha = runGit(bare, ['rev-parse', '--verify', '--quiet', 'main:marketplace.json']);
    if (sha.code !== 0) return null;
    return { content: Buffer.from(out(bare, 'show', 'main:marketplace.json')).toString('base64'), sha: sha.stdout.trim() };
  };
  const putIndex = (input: string): Reply => {
    const body = JSON.parse(input) as { message: string; content: string; sha?: string };
    if (body.sha !== index()?.sha) return { code: 1, stderr: 'gh: is at a different sha (HTTP 409)' };
    out(scratch, 'fetch', '-q', 'origin');
    out(scratch, 'reset', '-q', '--hard', 'origin/main');
    writeFileSync(join(scratch, 'marketplace.json'), Buffer.from(body.content, 'base64'));
    out(scratch, 'add', '--', 'marketplace.json');
    out(scratch, ...IDENTITY, 'commit', '-q', '-m', body.message);
    out(scratch, 'push', '-q', 'origin', 'HEAD:main');
    return { code: 0, stdout: '{}' };
  };
  const run = (args: readonly string[], input?: string): Reply => {
    const [cmd, sub, tag] = args;
    if (cmd === 'api') {
      const path = args.find((a) => a.startsWith('repos/'))!;
      const tagRef = /\/git\/ref\/tags\/(.+)$/.exec(path)?.[1];
      if (tagRef) {
        const sha = tagSha(tagRef);
        return sha ? { code: 0, stdout: JSON.stringify({ object: { type: 'commit', sha } }) } : notFound;
      }
      if (args.includes('PUT')) return putIndex(input!);
      const file = index();
      return file ? { code: 0, stdout: JSON.stringify(file) } : notFound;
    }
    const release = releases.get(tag!);
    if (cmd !== 'release') throw new Error(`fake gh: unexpected ${args.join(' ')}`);
    if (sub === 'view') {
      if (!release) return { code: 1, stderr: 'release not found' };
      return { code: 0, stdout: JSON.stringify({ isDraft: release.isDraft, targetCommitish: release.targetCommitish, assets: [...release.assets.keys()].map((name) => ({ name, state: release.starters?.has(name) ? 'starter' : 'uploaded' })) }) };
    }
    if (sub === 'create') {
      if (release) return { code: 1, stderr: 'a release with the same tag name already exists' };
      if (args.includes('--verify-tag') && !tagSha(tag!)) return { code: 1, stderr: 'tag not found' };
      const target = flag(args, '--target') ?? tagSha(tag!)!;
      if (!tagSha(tag!)) out(bare, 'tag', tag!, target);
      releases.set(tag!, { isDraft: false, targetCommitish: target, assets: new Map() });
      addAsset(tag!, args[3]!);
      return { code: 0 };
    }
    if (!release) return { code: 1, stderr: 'release not found' };
    if (sub === 'upload') {
      if (release.assets.has(basename(args[3]!))) return { code: 1, stderr: 'asset already exists' };
      addAsset(tag!, args[3]!);
      return { code: 0 };
    }
    if (sub === 'delete-asset') {
      release.assets.delete(args[3]!);
      release.starters?.delete(args[3]!);
      return { code: 0 };
    }
    if (sub === 'edit') {
      if (!tagSha(tag!)) out(bare, 'tag', tag!, release.targetCommitish);
      release.isDraft = false;
      return { code: 0 };
    }
    if (sub === 'download') {
      const name = flag(args, '--pattern')!;
      const dir = flag(args, '--dir')!;
      if (!release.assets.has(name) || release.isDraft) return { code: 1, stderr: 'no assets to download' };
      if (release.starters?.has(name)) return { code: 1, stderr: 'incomplete asset cannot be downloaded' };
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      copyFileSync(release.assets.get(name)!, join(dir, name));
      return { code: 0 };
    }
    throw new Error(`fake gh: unexpected ${args.join(' ')}`);
  };
  const gh: Gh = async (args, input) => {
    const line = args.join(' ');
    calls.push(line);
    const failure = failures.find((f) => f.times > 0 && line.startsWith(f.prefix));
    if (failure) {
      failure.times--;
      return { code: failure.reply.code, stdout: failure.reply.stdout ?? '', stderr: failure.reply.stderr ?? '' };
    }
    const r = run(args, input);
    return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { gh, releases, calls, failNext: (prefix, reply, times = 1) => void failures.push({ prefix, reply, times }), addAsset };
}

/** gh calls that change GitHub state. */
export const writes = (calls: readonly string[]): string[] =>
  calls.filter((c) => /^release (create|upload|edit|delete-asset)\b/.test(c) || c.includes('-X PUT'));
