// Release assets contain build outputs at the archive root. Marketplace entries sort newest-first in the index release's asset; interrupted releases resume without replacing completed artifacts.
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { list, extract } from 'tar';
import { describe, expect, it } from 'vitest';
import { parseInstalledManifest, PLUGIN_SDK_VERSION } from '@shared/installedPlugins';
import { parseMarketplaceIndex, type MarketplaceRelease } from '@shared/marketplace';
import { buildReleaseAsset } from '../scripts/pluginAsset';
import { ensureReleased, readIndex, seedIndex, withRelease, type BuiltAsset, type IndexStore } from '../scripts/pluginRelease';
import { branchIndex } from '../scripts/pluginReleaseState';
import { tempDir } from './helpers';
import { GIT_TEST_TIMEOUT_MS, REPO, commit, fakeAsset, fakeGh, git, listed, out, pluginRepo, writes } from './pluginReleaseHarness';

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
  const store: IndexStore = { fallback: () => (out(repo.clone, 'fetch', '-q', 'origin'), branchIndex(git, repo.clone)), target };
  let builds = 0;
  const run = (asset: (dir: string) => Promise<BuiltAsset> = (dir) => fakeAsset(dir, ID, VERSION)) =>
    ensureReleased({ repo: REPO, id: ID, version: VERSION, target, workDir: tempDir(), index: store, gh: fake.gh, log: quiet, buildAsset: (dir) => (builds++, asset(dir)) });
  const index = () => parseMarketplaceIndex(fake.index());
  /** A built asset outside any release, to seed one. */
  const asset = async (sdk = PLUGIN_SDK_VERSION) => (await fakeAsset(tempDir(), ID, VERSION, sdk)).file;
  /** The index writes: `release create marketplace` or `release upload marketplace`. */
  const indexWrites = () => writes(fake.calls).filter((c) => c.split(' ')[2] === 'marketplace');
  return { repo, target, fake, store, run, index, asset, indexWrites, builds: () => builds };
}

const verbs = (calls: string[]): string[] => calls.map((c) => c.split(' ').slice(0, 3).join(' ').replace(/ alpha-v.*$/, ''));

describe('ensureReleased', { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  it('releases from nothing, tagged at the target, and lists it in a new index release without touching main', async () => {
    const w = world();
    const main = out(w.repo.bare, 'rev-parse', 'main');
    const done = await w.run();
    expect(done).toMatchObject({ tag: TAG, sdk: PLUGIN_SDK_VERSION, listed: true });
    expect(out(w.repo.bare, 'rev-parse', `${TAG}^{commit}`)).toBe(w.target);
    expect(w.index().plugins).toEqual([{ id: ID, name: 'ALPHA', description: `Fixture ${ID}.`, releases: [{ version: VERSION, tag: TAG, asset: ASSET, sha256: done.sha256, sdk: PLUGIN_SDK_VERSION }] }]);
    expect(w.indexWrites()).toEqual([expect.stringMatching(/^release create marketplace .* --target [0-9a-f]{40} .*--latest=false$/)]);
    expect(out(w.repo.bare, 'rev-parse', 'main')).toBe(main);
    expect(w.builds()).toBe(1);
  });

  it("starts the index from main's marketplace.json, then replaces the release's asset", async () => {
    const w = world();
    listed(w.repo, 'beta', '1.0.0', w.target);
    await w.run();
    expect(w.index().plugins.map((p) => p.id)).toEqual(['beta', ID]);
    w.fake.setIndex({ format: 1, plugins: [{ id: 'gamma', name: 'G', description: '', releases: [{ version: '1.0.0', tag: 'gamma-v1.0.0', asset: 'g.tar.gz', sha256: SHA, sdk: '1.0.0' }] }] });
    w.fake.releases.delete(TAG);
    out(w.repo.bare, 'tag', '-d', TAG);
    await w.run();
    // The asset, once it exists, is the index; main's copy is not read again.
    expect(w.index().plugins.map((p) => p.id)).toEqual(['gamma', ID]);
    // A rewrite uploads the backup before it replaces the index asset. The file's name is read by the command's shape: its folder may hold spaces.
    expect(w.indexWrites().map((c) => c.replace(/^(release \w+) marketplace .*?[\\/]([^\\/]+?\.json) --.*$/, '$1 $2'))).toEqual(['release create marketplace.json', 'release upload marketplace.backup.json', 'release upload marketplace.json']);
    expect(w.indexWrites()[2]).toContain('--clobber');
  });

  it('keeps a backup of each rewrite, read while an interrupted rewrite left the index asset missing; a starter asset is no index', async () => {
    const w = world();
    await w.run();
    const first = w.fake.index();
    const store = w.fake.releases.get('marketplace')!;
    // Neither asset (and main has no file): nothing to read.
    store.assets.clear();
    expect(await readIndex(w.fake.gh, REPO, w.store, tempDir())).toBeNull();
    // With only a backup holding the published entry, reads use it rather than main's older copy.
    w.fake.addAsset('marketplace', (() => { const f = join(tempDir(), 'marketplace.backup.json'); writeFileSync(f, JSON.stringify(first)); return f; })());
    expect(await readIndex(w.fake.gh, REPO, w.store, tempDir())).toEqual(first);
    // Hosts read only marketplace.json: the next publish restores it from the backup, uploading nothing else, so a failed restore keeps the backup.
    w.fake.failNext('release upload marketplace', { code: 1, stderr: 'down' });
    await expect(seedIndex(w.fake.gh, REPO, w.store, tempDir())).rejects.toThrow(/gh release upload failed: down/);
    expect([...store.assets.keys()]).toEqual(['marketplace.backup.json']);
    const restores = w.fake.calls.length;
    expect(await seedIndex(w.fake.gh, REPO, w.store, tempDir())).toBe(true);
    expect(writes(w.fake.calls.slice(restores))).toEqual([expect.stringMatching(/^release upload marketplace .*[\\/]marketplace\.json --repo /)]);
    expect(w.fake.index()).toEqual(first);
    expect(await seedIndex(w.fake.gh, REPO, w.store, tempDir())).toBe(false);
    // A failed upload's placeholder isn't an index: seeding replaces it.
    store.assets.clear();
    w.fake.addAsset('marketplace', (() => { const f = join(tempDir(), 'marketplace.json'); writeFileSync(f, ''); return f; })());
    store.starters = new Set(['marketplace.json']);
    listed(w.repo, 'beta', '1.0.0', w.target);
    expect(await seedIndex(w.fake.gh, REPO, w.store, tempDir())).toBe(true);
    expect(w.fake.calls.at(-1)).toMatch(/^release upload marketplace .*marketplace\.json .*--clobber$/);
  });

  it('creates the release on an existing tag at the target', async () => {
    const w = world();
    out(w.repo.bare, 'tag', TAG, w.target);
    await w.run();
    expect(w.fake.calls.find((c) => c.startsWith(`release create ${TAG}`))).toContain('--verify-tag');
    expect(w.index().plugins[0]!.releases[0]!.version).toBe(VERSION);
  });

  it('uploads to a draft without its asset, then publishes it', async () => {
    const w = world();
    w.fake.releases.set(TAG, { isDraft: true, targetCommitish: w.target, assets: new Map() });
    await w.run();
    expect(verbs(writes(w.fake.calls))).toEqual(['release upload', 'release edit', 'release create marketplace']);
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
    expect(verbs(writes(w.fake.calls))).toEqual(['release upload', 'release create marketplace']);
    expect(w.fake.calls.some((c) => c.startsWith(`release upload ${TAG}`) && c.includes('--clobber'))).toBe(false);
  });

  it("replaces only a failed upload's empty placeholder, before publishing", async () => {
    const w = world();
    w.fake.releases.set(TAG, { isDraft: true, targetCommitish: w.target, assets: new Map(), starters: new Set([ASSET]) });
    w.fake.addAsset(TAG, await w.asset());
    await w.run();
    expect(verbs(writes(w.fake.calls))).toEqual(['release delete-asset', 'release upload', 'release edit', 'release create marketplace']);
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

  it('throws when the index write fails; a plain retry lists the standing release without building again', async () => {
    const w = world();
    w.fake.failNext('release create marketplace', { code: 1, stderr: 'gh: Server Error (HTTP 502)' });
    await expect(w.run()).rejects.toThrow(/gh release create failed: gh: Server Error/);
    expect(w.fake.index()).toBeNull();
    await w.run();
    expect(w.builds()).toBe(1);
    expect(w.index().plugins[0]!.releases[0]!.tag).toBe(TAG);
  });

  it('refuses a malformed index asset, writing nothing to it', async () => {
    const w = world();
    w.fake.setIndex('{ not json');
    await expect(readIndex(w.fake.gh, REPO, w.store, tempDir())).rejects.toThrow(/marketplace release's marketplace.json is unreadable; fix it by hand/);
    await expect(w.run()).rejects.toThrow(/unreadable/);
    expect(w.indexWrites()).toEqual([]);
  });

  it('refuses a listing that names another asset for the version', async () => {
    const w = world();
    await w.run();
    const raw = w.fake.index() as { plugins: { releases: { sha256: string }[] }[] };
    raw.plugins[0]!.releases[0]!.sha256 = SHA;
    w.fake.setIndex(raw);
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
