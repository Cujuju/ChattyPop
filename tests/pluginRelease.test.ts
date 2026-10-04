// Plugin publishing (scripts/pluginRelease.ts, scripts/pluginAsset.ts, docs/plugin-architecture.md §16): the asset is
// the build folder's contents at the archive root, released at its target commit and listed in marketplace.json newest
// first. ensureReleased converges from any partial state an interrupted run leaves, never replacing anything.
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { list, extract } from 'tar';
import { describe, expect, it } from 'vitest';
import { parseInstalledManifest, PLUGIN_SDK_VERSION } from '@shared/installedPlugins';
import { parseMarketplaceIndex, type MarketplaceRelease } from '@shared/marketplace';
import { buildReleaseAsset } from '../scripts/pluginAsset';
import { ensureReleased, withRelease, type BuiltAsset } from '../scripts/pluginRelease';
import { tempDir } from './helpers';
import { GIT_TEST_TIMEOUT_MS, REPO, commit, fakeAsset, fakeGh, git, out, pluginRepo, pull, writes } from './pluginReleaseHarness';

const SHA = 'a'.repeat(64);
const rel = (version: string): MarketplaceRelease => ({ version, tag: `p-v${version}`, asset: `p-${version}.tar.gz`, sha256: SHA, sdk: '1.0.0' });
const plugin = { id: 'demo', name: 'P', description: 'New words.' };
const quiet = (): void => undefined;
/** The plugin:check fixture, released from a plugin repo the test makes. */
const FIXTURE = join(import.meta.dirname, 'fixtures/checkprobe');
/** Building the fixture: its descriptor beside its repo's plugins, two Vite builds. */
const BUILD_TIMEOUT_MS = 120_000;

describe('withRelease', () => {
  it('creates marketplace.json when the repo has none', () => {
    expect(withRelease(null, plugin, rel('1.0.0'))).toEqual({ format: 1, plugins: [{ ...plugin, releases: [rel('1.0.0')] }] });
  });

  it('keeps releases newest first, and the entry\'s words follow its newest release', () => {
    const raw = { format: 1, plugins: [{ id: 'demo', name: 'Old', description: 'Old words.', releases: [rel('1.2.0'), rel('1.0.0')] }] };
    const older = withRelease(raw, plugin, rel('1.1.0'));
    expect(parseMarketplaceIndex(older).plugins[0]).toMatchObject({ name: 'Old', releases: [rel('1.2.0'), rel('1.1.0'), rel('1.0.0')] });
    const newest = withRelease(raw, plugin, rel('1.10.0'));
    expect(parseMarketplaceIndex(newest).plugins[0]).toMatchObject({ name: 'P', description: 'New words.', releases: [rel('1.10.0'), rel('1.2.0'), rel('1.0.0')] });
    expect(raw.plugins[0]!.releases).toHaveLength(2);
  });

  it('leaves every other field as it was', () => {
    const other = { id: 'other', name: 'Other', description: '', releases: [], source: { path: 'plugins/other', branch: 'main' } };
    const raw = { format: 1, note: 'kept', plugins: [other, { id: 'demo', name: 'P', description: '', releases: [rel('1.0.0')], source: { path: 'plugins/demo', branch: 'main' } }] };
    expect(withRelease(raw, plugin, rel('2.0.0'))).toEqual({ ...raw, plugins: [other, { ...raw.plugins[1], description: 'New words.', releases: [rel('2.0.0'), rel('1.0.0')] }] });
  });

  it('refuses a version already listed, and an index this host can\'t read', () => {
    expect(() => withRelease({ format: 1, plugins: [{ ...plugin, releases: [rel('1.0.0')] }] }, plugin, rel('1.0.0'))).toThrow(/already lists demo 1.0.0/);
    expect(() => withRelease({ format: 2, plugins: [] }, plugin, rel('1.0.0'))).toThrow(/format 2/);
  });
});

const ID = 'alpha';
const VERSION = '1.0.1';
const TAG = `${ID}-v${VERSION}`;
const ASSET = `${ID}-${VERSION}.tar.gz`;

/** A plugin repo with a target commit, a fake gh over it, and ensureReleased bound to them; counts asset builds. */
function world() {
  const repo = pluginRepo({ [ID]: VERSION });
  const target = out(repo.clone, 'rev-parse', 'HEAD');
  const fake = fakeGh(repo.bare);
  let builds = 0;
  const run = (asset: (dir: string) => Promise<BuiltAsset> = (dir) => fakeAsset(dir, ID, VERSION)) =>
    ensureReleased({ repo: REPO, id: ID, version: VERSION, target, workDir: tempDir(), gh: fake.gh, log: quiet, buildAsset: (dir) => (builds++, asset(dir)) });
  const index = () => parseMarketplaceIndex(JSON.parse(out(repo.bare, 'show', 'main:marketplace.json')));
  /** A built asset outside any release, to seed one. */
  const asset = async (sdk = PLUGIN_SDK_VERSION) => (await fakeAsset(tempDir(), ID, VERSION, sdk)).file;
  return { repo, target, fake, run, index, asset, builds: () => builds };
}

describe('ensureReleased', { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  it('releases and lists from nothing, tagged at the target', async () => {
    const w = world();
    const done = await w.run();
    expect(done).toMatchObject({ tag: TAG, sdk: PLUGIN_SDK_VERSION, listed: true });
    expect(out(w.repo.bare, 'rev-parse', `${TAG}^{commit}`)).toBe(w.target);
    expect(w.index().plugins).toEqual([{ id: ID, name: 'ALPHA', description: `Fixture ${ID}.`, releases: [{ version: VERSION, tag: TAG, asset: ASSET, sha256: done.sha256, sdk: PLUGIN_SDK_VERSION }] }]);
    expect(out(w.repo.bare, 'log', '-1', '--format=%s', 'main')).toBe(`release: ${TAG}`);
    expect(w.builds()).toBe(1);
  });

  it('creates the release on an existing tag at the target', async () => {
    const w = world();
    out(w.repo.bare, 'tag', TAG, w.target);
    await w.run();
    expect(w.fake.calls.find((c) => c.startsWith('release create'))).toContain('--verify-tag');
    expect(w.index().plugins[0]!.releases[0]!.version).toBe(VERSION);
  });

  it('uploads to a draft without its asset, then publishes it', async () => {
    const w = world();
    w.fake.releases.set(TAG, { isDraft: true, targetCommitish: w.target, assets: new Map() });
    await w.run();
    expect(writes(w.fake.calls).map((c) => c.split(' ').slice(0, 2).join(' '))).toEqual(['release upload', 'release edit', 'api -X']);
    expect(out(w.repo.bare, 'rev-parse', `${TAG}^{commit}`)).toBe(w.target);
  });

  it('publishes a draft with its asset without building, its sdk read from the asset', async () => {
    const w = world();
    w.fake.releases.set(TAG, { isDraft: true, targetCommitish: w.target, assets: new Map() });
    w.fake.addAsset(TAG, await w.asset('0.9.0'));
    const done = await w.run();
    expect(w.builds()).toBe(0);
    expect(done.sdk).toBe('0.9.0');
    expect(w.index().plugins[0]!.releases[0]!.sdk).toBe('0.9.0');
  });

  it('uploads to a published release without its asset, never replacing one', async () => {
    const w = world();
    out(w.repo.bare, 'tag', TAG, w.target);
    w.fake.releases.set(TAG, { isDraft: false, targetCommitish: w.target, assets: new Map() });
    await w.run();
    expect(writes(w.fake.calls).map((c) => c.split(' ').slice(0, 2).join(' '))).toEqual(['release upload', 'api -X']);
    expect(w.fake.calls.some((c) => c.includes('--clobber'))).toBe(false);
  });

  it('replaces only a failed upload\'s empty placeholder, before publishing', async () => {
    const w = world();
    w.fake.releases.set(TAG, { isDraft: true, targetCommitish: w.target, assets: new Map(), starters: new Set([ASSET]) });
    w.fake.addAsset(TAG, await w.asset());
    await w.run();
    expect(writes(w.fake.calls).map((c) => c.split(' ').slice(0, 2).join(' '))).toEqual(['release delete-asset', 'release upload', 'release edit', 'api -X']);
    expect(w.builds()).toBe(1);
  });

  it('lists a published release with its asset, and does nothing once listed', async () => {
    const w = world();
    out(w.repo.bare, 'tag', TAG, w.target);
    w.fake.releases.set(TAG, { isDraft: false, targetCommitish: w.target, assets: new Map() });
    w.fake.addAsset(TAG, await w.asset());
    expect((await w.run()).listed).toBe(true);
    expect(writes(w.fake.calls)).toHaveLength(1);
    const before = w.fake.calls.length;
    expect((await w.run()).listed).toBe(false);
    expect(writes(w.fake.calls.slice(before))).toEqual([]);
    expect(w.builds()).toBe(0);
  });

  it('refuses a tag or draft at another commit, writing nothing', async () => {
    const tagged = world();
    const elsewhere = commit(tagged.repo.other, { 'x.txt': 'x\n' }, 'docs: x');
    out(tagged.repo.bare, 'tag', TAG, elsewhere);
    await expect(tagged.run()).rejects.toThrow(`Tag ${TAG} on ${REPO} is at ${elsewhere}, not its release target`);
    const drafted = world();
    drafted.fake.releases.set(TAG, { isDraft: true, targetCommitish: 'main', assets: new Map() });
    await expect(drafted.run()).rejects.toThrow(/targets main, not/);
    expect([...writes(tagged.fake.calls), ...writes(drafted.fake.calls)]).toEqual([]);
  });

  it('re-reads marketplace.json when its write conflicts, and throws when it fails otherwise', async () => {
    const w = world();
    w.fake.failNext('api -X PUT', { code: 1, stderr: 'gh: sha does not match (HTTP 409)' });
    expect((await w.run()).listed).toBe(true);
    expect(w.fake.calls.filter((c) => c.includes('-X PUT'))).toHaveLength(2);

    const lost = world();
    lost.fake.failNext('api -X PUT', { code: 1, stderr: 'gh: Not Found (HTTP 404)' });
    await expect(lost.run()).rejects.toThrow(/Writing marketplace.json failed: gh: Not Found/);
    // The release stands; a plain retry lists it without building again.
    await lost.run();
    expect(lost.builds()).toBe(1);
    expect(lost.index().plugins[0]!.releases[0]!.tag).toBe(TAG);
  });

  it('refuses a listing that names another asset for the version', async () => {
    const w = world();
    await w.run();
    const raw = JSON.parse(out(w.repo.bare, 'show', 'main:marketplace.json')) as { plugins: { releases: { sha256: string }[] }[] };
    raw.plugins[0]!.releases[0]!.sha256 = SHA;
    pull(w.repo.other);
    commit(w.repo.other, { 'marketplace.json': JSON.stringify(raw) }, 'fix: hand edit');
    await expect(w.run()).rejects.toThrow(/lists alpha 1.0.1 as alpha-v1.0.1 a{64}, not the published/);
  });
});

describe('buildReleaseAsset', () => {
  it('builds the target commit in a worktree it removes, packing the build at the archive root', async () => {
    const repo = pluginRepo({});
    cpSync(FIXTURE, join(repo.other, 'plugins/checkprobe'), { recursive: true });
    out(repo.other, 'add', '--', 'plugins/checkprobe');
    const target = commit(repo.other, {}, 'feat(checkprobe): add');
    commit(repo.other, { 'plugins/checkprobe/shared/later.ts': 'export const later = 1;\n' }, 'fix(checkprobe): later');
    out(repo.clone, 'fetch', '-q', 'origin');
    const checked: string[] = [];
    const workDir = tempDir();
    const built = await buildReleaseAsset({ repoDir: repo.clone, id: 'checkprobe', target, workDir, git, log: quiet, check: async ({ pluginDir }) => (checked.push(pluginDir), null) });
    expect(checked).toEqual([join(workDir, 'tree', 'plugins', 'checkprobe')]);
    expect(existsSync(join(workDir, 'tree'))).toBe(false);
    expect(out(repo.clone, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(basename(built.file)).toBe(`checkprobe-${built.manifest.version}.tar.gz`);
    expect(built.notes).toContain(`Built from ${target} by ChattyPop`);
    expect(built.notes).toContain(`plugin SDK ${PLUGIN_SDK_VERSION}`);
    const paths: string[] = [];
    await list({ file: built.file, onReadEntry: (e) => void paths.push(e.path) });
    expect(paths).toContain('plugin.json');
    expect(paths).toContain('node/shared.js');
    expect(paths.some((p) => p.includes('later'))).toBe(false);
    expect(paths.every((p) => ['plugin.json', 'node', 'browser'].includes(p.split('/')[0]!))).toBe(true);
    const unpacked = tempDir();
    await extract({ file: built.file, cwd: unpacked });
    expect(parseInstalledManifest(JSON.parse(readFileSync(join(unpacked, 'plugin.json'), 'utf8')))).toEqual(built.manifest);
  }, BUILD_TIMEOUT_MS);

  it('refuses a plugin whose check fails, building nothing', async () => {
    const repo = pluginRepo({ [ID]: VERSION });
    const target = out(repo.clone, 'rev-parse', 'HEAD');
    const workDir = tempDir();
    await expect(buildReleaseAsset({ repoDir: repo.clone, id: ID, target, workDir, git, log: quiet, check: async () => 'tests' })).rejects.toThrow(/plugin:check failed at tests/);
    expect(existsSync(join(workDir, 'out'))).toBe(false);
  }, GIT_TEST_TIMEOUT_MS);
});
