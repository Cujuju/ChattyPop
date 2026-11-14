// Real-repository release tests use fake gh. A pull request's branch is stamped (--stamp); main is only published, committing nothing; --check
// fails a pull request that changed a plugin without stamping it. Failures preserve resumable state.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLUGIN_SDK_VERSION } from '@shared/installedPlugins';
import { parseMarketplaceIndex } from '@shared/marketplace';
import { main, releaseChanged, type ReleaseChangedOptions } from '../scripts/pluginReleaseChanged';
import { manifestVersion } from '../scripts/pluginScan/manifest';
import { GIT_TEST_TIMEOUT_MS, REPO, commit, fakeAsset, fakeGh, git, listed, out, pluginRepo, pull, recordingGit, sharedFile, writes, type PluginRepo } from './pluginReleaseHarness';

const quiet = (): void => undefined;
/** Two runs, each evaluating stamped descriptors and driving a few dozen git commands. */
const RUN_TEST_TIMEOUT_MS = 2 * GIT_TEST_TIMEOUT_MS;

/** The version `id`'s descriptor holds at `rev`. */
const versionAt = (dir: string, rev: string, id: string): string => manifestVersion({ rel: sharedFile(id), text: out(dir, 'show', `${rev}:${sharedFile(id)}`) }).version;
const tagAt = (repo: PluginRepo, tag: string): string => out(repo.bare, 'rev-parse', `${tag}^{commit}`);
const mainAt = (repo: PluginRepo): string => out(repo.bare, 'rev-parse', 'main');

/** Release runs over `repo` with a fake gh, a passing (or `checkFails`) check and fake asset builds; every git command is recorded. */
function runner(repo: PluginRepo) {
  const fake = fakeGh(repo.bare);
  const checked: string[] = [];
  const recorded = recordingGit();
  let checkFails = false;
  const run = (o: Partial<ReleaseChangedOptions> = {}) =>
    releaseChanged({
      repoDir: repo.clone, repo: REPO, dryRun: false, sdkRebuild: false, gh: fake.gh, git: recorded.git, log: quiet,
      check: async ({ pluginDir }) => (checked.push(pluginDir), checkFails ? 'tests' : null),
      buildAsset: (id, target, workDir) => fakeAsset(workDir, id, versionAt(repo.clone, target, id)),
      ...o,
    });
  const listedVersions = (id: string): string[] => parseMarketplaceIndex(fake.index()).plugins.find((p) => p.id === id)?.releases.map((r) => r.version) ?? [];
  /** Stamps on a new branch of the clone, then lands it on main as a squash merge would (one commit, the branch's subjects gone). */
  const land = async (branch: string, edit: () => void, o: Partial<ReleaseChangedOptions> = {}) => {
    out(repo.clone, 'checkout', '-q', '-b', branch, 'origin/main');
    edit();
    const stamped = await run({ mode: 'stamp', ...o });
    const tree = out(repo.clone, 'rev-parse', 'HEAD^{tree}');
    const squash = out(repo.clone, '-c', 'user.name=Merger', '-c', 'user.email=m@example.com', 'commit-tree', tree, '-p', 'origin/main', '-m', `Pull request ${branch}`);
    out(repo.clone, 'push', '-q', 'origin', `${squash}:main`);
    out(repo.clone, 'checkout', '-q', 'main');
    pull(repo.clone);
    return stamped;
  };
  return { fake, checked, run, land, listedVersions, commands: recorded.commands, failChecks: () => void (checkFails = true) };
}

/** git commands that would write to main: pushes and commits. */
const mainWrites = (commands: readonly string[]): string[] => commands.filter((c) => /^(push|commit)\b/.test(c));

describe('plugin:release-changed publish (CI on main)', { timeout: RUN_TEST_TIMEOUT_MS }, () => {
  it('publishes a first release at main and lists it in the index release, committing and pushing nothing', async () => {
    const repo = pluginRepo({ alpha: '1.0.0' });
    const before = mainAt(repo);
    const r = runner(repo);
    expect(await r.run()).toEqual({ released: ['alpha-v1.0.0'], stamped: [], failed: [] });
    expect(tagAt(repo, 'alpha-v1.0.0')).toBe(before);
    expect(r.listedVersions('alpha')).toEqual(['1.0.0']);
    expect(mainAt(repo)).toBe(before);
    expect(mainWrites(r.commands)).toEqual([]);
    expect(await r.run()).toEqual({ released: [], stamped: [], failed: [] });
  });

  it("creates the index release from main's marketplace.json on its first run, then reads only the release", async () => {
    const repo = pluginRepo({ alpha: '1.0.0', beta: '1.0.0' });
    listed(repo, 'alpha', '1.0.0', mainAt(repo));
    const r = runner(repo);
    expect(await r.run()).toEqual({ released: ['beta-v1.0.0'], stamped: [], failed: [] });
    expect(writes(r.fake.calls)[0]).toMatch(/^release create marketplace /);
    expect(r.listedVersions('alpha')).toEqual(['1.0.0']);
    expect(r.listedVersions('beta')).toEqual(['1.0.0']);
    // main's copy is now behind the release, and that is fine: the release is the index.
    expect(JSON.parse(out(repo.bare, 'show', 'main:marketplace.json'))).toMatchObject({ plugins: [{ id: 'alpha' }] });
  });

  it('resumes an interrupted release at its tag, and reports a later unstamped change instead of releasing it', async () => {
    const repo = pluginRepo({ alpha: '1.0.0' });
    const r = runner(repo);
    const first = mainAt(repo);
    r.fake.failNext('release download alpha-v1.0.0', { code: 1, stderr: 'network down' });
    const interrupted = await r.run();
    expect(interrupted.failed).toEqual([expect.stringMatching(/^alpha-v1\.0\.0: .*network down/)]);
    expect(tagAt(repo, 'alpha-v1.0.0')).toBe(first);
    pull(repo.other);
    commit(repo.other, { 'plugins/alpha/shared/extra.ts': 'export const later = 1;\n' }, 'fix(alpha): later');
    pull(repo.clone);
    // The tagged content is released as it was; the later edit is reported for a stamp, not shipped under the old version.
    expect(await r.run()).toEqual({ released: ['alpha-v1.0.0'], stamped: [], failed: [expect.stringMatching(/^alpha: changed since alpha-v1\.0\.0 was tagged without a raised version; stamp it/)] });
    expect(tagAt(repo, 'alpha-v1.0.0')).toBe(first);
    expect((await r.run()).failed).toEqual([expect.stringMatching(/^alpha: changed since alpha-v1\.0\.0 without a raised version; stamp it in a pull request/)]);
    expect(mainWrites(r.commands)).toEqual([]);
  });

  it('finishes an old release intent at its commit before anything else', async () => {
    const repo = pluginRepo({ alpha: '1.0.0' });
    listed(repo, 'alpha', '1.0.0', mainAt(repo));
    pull(repo.other);
    const intent = commit(repo.other, { [sharedFile('alpha')]: readFileSync(join(repo.other, sharedFile('alpha')), 'utf8').replace("'1.0.0'", "'1.0.1'") }, 'chore(release): alpha-v1.0.1');
    commit(repo.other, { 'README.md': 'later\n' }, 'docs: later');
    pull(repo.clone);
    const r = runner(repo);
    expect(await r.run()).toEqual({ released: ['alpha-v1.0.1'], stamped: [], failed: [] });
    expect(tagAt(repo, 'alpha-v1.0.1')).toBe(intent);
  });

  it('reports a pending intent its release left pending once, and a stamp raises an edit made after an unpublished tag', async () => {
    const repo = pluginRepo({ alpha: '1.0.0' });
    listed(repo, 'alpha', '1.0.0', mainAt(repo));
    pull(repo.other);
    commit(repo.other, { [sharedFile('alpha')]: readFileSync(join(repo.other, sharedFile('alpha')), 'utf8').replace("'1.0.0'", "'1.0.1'") }, 'chore(release): alpha-v1.0.1');
    pull(repo.clone);
    const r = runner(repo);
    r.fake.failNext('release create alpha-v1.0.1', { code: 1, stderr: 'down' });
    expect((await r.run()).failed).toEqual([expect.stringMatching(/^alpha-v1\.0\.1: gh release create failed: down/)]);

    const tagged = pluginRepo({ beta: '1.0.0' });
    const t = runner(tagged);
    t.fake.failNext('release download beta-v1.0.0', { code: 1, stderr: 'down' });
    await t.run();
    expect(await t.land('later', () => void commit(tagged.clone, { 'plugins/beta/shared/x.ts': 'export const x = 1;\n' }, 'fix(beta): later', false))).toMatchObject({ stamped: ['beta-v1.0.1'] });
    expect(await t.run()).toEqual({ released: ['beta-v1.0.1'], stamped: [], failed: [] });
  });

  it('restores the index asset from its backup when replacing it failed after the delete, on the next publish', async () => {
    const repo = pluginRepo({ alpha: '1.0.0', beta: '1.0.0' });
    const r = runner(repo);
    r.fake.failNext('release create beta-v1.0.0', { code: 1, stderr: 'down' });
    await r.run();
    // beta's listing: the backup goes up, then --clobber deletes the index asset and the upload fails.
    const index = r.fake.releases.get('marketplace')!;
    const gh: typeof r.fake.gh = async (args, input) => {
      const replacing = args[0] === 'release' && args[1] === 'upload' && args[2] === 'marketplace' && /[\\/]marketplace\.json$/.test(args[3]!);
      if (!replacing) return r.fake.gh(args, input);
      index.assets.delete('marketplace.json');
      return { code: 1, stdout: '', stderr: 'down' };
    };
    expect((await r.run({ gh })).failed).toEqual([expect.stringMatching(/^beta-v1\.0\.0: gh release upload failed: down/)]);
    expect(index.assets.has('marketplace.json')).toBe(false);
    // The retry restores marketplace.json (what hosts read) from the backup, then has nothing left to release.
    expect(await r.run()).toEqual({ released: [], stamped: [], failed: [] });
    expect(r.listedVersions('beta')).toEqual(['1.0.0']);
    expect(index.assets.has('marketplace.json')).toBe(true);
  });

  it('finishes only the failed plugin of a batch on the next plain run', async () => {
    const repo = pluginRepo({ alpha: '1.0.0', beta: '1.0.0' });
    const r = runner(repo);
    r.fake.failNext('release create beta-v1.0.0', { code: 1, stderr: 'upload failed' });
    expect(await r.run()).toEqual({ released: ['alpha-v1.0.0'], stamped: [], failed: [expect.stringMatching(/^beta-v1\.0\.0: /)] });
    const calls = r.fake.calls.length;
    expect(await r.run()).toEqual({ released: ['beta-v1.0.0'], stamped: [], failed: [] });
    expect(writes(r.fake.calls.slice(calls)).filter((c) => c.includes('alpha'))).toEqual([]);
  });

  it('writes nothing when preflight fails', async () => {
    const dirty = pluginRepo({ alpha: '1.0.0' });
    writeFileSync(join(dirty.clone, 'README.md'), 'edited\n');
    const stale = pluginRepo({ alpha: '1.0.0' });
    commit(stale.other, { 'x.txt': 'x\n' }, 'docs: x');
    const branch = pluginRepo({ alpha: '1.0.0' });
    out(branch.clone, 'checkout', '-q', '-b', 'topic');
    for (const [repo, why] of [[dirty, /uncommitted changes/], [stale, /pull first/], [branch, /on topic; releases come from main/]] as const) {
      const r = runner(repo);
      const before = mainAt(repo);
      await expect(r.run()).rejects.toThrow(why);
      expect(r.fake.calls).toEqual([]);
      expect(mainAt(repo)).toBe(before);
    }
  });

  it('prints the plan on a dry run, writing nothing', async () => {
    const repo = pluginRepo({ alpha: '1.0.0' });
    const r = runner(repo);
    const lines: string[] = [];
    expect(await r.run({ dryRun: true, log: (l) => lines.push(l) })).toEqual({ released: [], stamped: [], failed: [] });
    expect(lines).toContain(`Would publish alpha-v1.0.0 at ${mainAt(repo)}`);
    expect(writes(r.fake.calls)).toEqual([]);
    expect(mainWrites(r.commands)).toEqual([]);
  });
});

describe('plugin:release-changed --stamp (a pull request)', { timeout: RUN_TEST_TIMEOUT_MS }, () => {
  it("stamps one version raised by each of the branch's commits, then main publishes it whatever the merge kept", async () => {
    const repo = pluginRepo({ alpha: '1.0.0', beta: '1.0.0' });
    const r = runner(repo);
    await r.run();
    const stamped = await r.land('topic', () => {
      commit(repo.clone, { 'plugins/alpha/shared/extra.ts': 'export const more = 1;\n' }, 'feat(alpha): more', false);
      commit(repo.clone, { 'plugins/alpha/shared/extra.ts': 'export const more = 2;\n' }, 'fix(alpha): more', false);
    });
    expect(stamped).toEqual({ released: [], stamped: ['alpha-v1.1.1'], failed: [] });
    expect(versionAt(repo.bare, 'main', 'alpha')).toBe('1.1.1');
    expect(out(repo.bare, 'log', '-1', '--format=%s', 'main')).toBe('Pull request topic');
    const before = mainAt(repo);
    expect(await r.run()).toEqual({ released: ['alpha-v1.1.1'], stamped: [], failed: [] });
    expect(tagAt(repo, 'alpha-v1.1.1')).toBe(before);
    expect(mainAt(repo)).toBe(before);
  });

  it("commits only the stamped files and the index copy, so main's file catches up with the release", async () => {
    const repo = pluginRepo({ alpha: '1.0.0' });
    const r = runner(repo);
    await r.run();
    out(repo.clone, 'checkout', '-q', '-b', 'topic');
    commit(repo.clone, { 'plugins/alpha/shared/extra.ts': 'export const x = 1;\n' }, 'fix(alpha): x', false);
    writeFileSync(join(repo.clone, 'untracked.txt'), 'left alone\n');
    out(repo.clone, 'add', '-N', 'untracked.txt');
    await expect(r.run({ mode: 'stamp' })).rejects.toThrow(/uncommitted changes/);
    out(repo.clone, 'rm', '-q', '--cached', 'untracked.txt');
    out(repo.clone, 'clean', '-qf');
    expect(await r.run({ mode: 'stamp' })).toEqual({ released: [], stamped: ['alpha-v1.0.1'], failed: [] });
    expect(out(repo.clone, 'log', '-1', '--format=%s')).toBe('chore: stamp alpha-v1.0.1; sync marketplace.json');
    expect(out(repo.clone, 'diff', '--name-only', 'HEAD~1', 'HEAD').split('\n').sort()).toEqual(['marketplace.json', sharedFile('alpha')]);
    expect(JSON.parse(out(repo.clone, 'show', 'HEAD:marketplace.json'))).toEqual(r.fake.index());
    // Stamped already: a second run has nothing to do.
    expect(await r.run({ mode: 'stamp' })).toEqual({ released: [], stamped: [], failed: [] });
  });

  it('copies the index alone when no plugin changed, and does nothing once it is current', async () => {
    const repo = pluginRepo({ alpha: '1.0.0' });
    const r = runner(repo);
    await r.run();
    out(repo.clone, 'checkout', '-q', '-b', 'docs');
    commit(repo.clone, { 'README.md': 'Docs.\n' }, 'docs: readme', false);
    expect(await r.run({ mode: 'stamp' })).toEqual({ released: [], stamped: [], failed: [] });
    expect(out(repo.clone, 'log', '-1', '--format=%s')).toBe('chore: sync marketplace.json from the marketplace release');
    const head = out(repo.clone, 'rev-parse', 'HEAD');
    await r.run({ mode: 'stamp' });
    expect(out(repo.clone, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('refuses main, a detached HEAD and a branch without the latest main, writing nothing', async () => {
    const repo = pluginRepo({ alpha: '1.0.0' });
    const r = runner(repo);
    await expect(r.run({ mode: 'stamp' })).rejects.toThrow(/is on main; stamp on your pull request's branch/);
    out(repo.clone, 'checkout', '-q', '--detach');
    await expect(r.run({ mode: 'stamp' })).rejects.toThrow(/detached HEAD/);
    out(repo.clone, 'checkout', '-q', '-b', 'old');
    pull(repo.other);
    commit(repo.other, { 'x.txt': 'x\n' }, 'docs: x');
    await expect(r.run({ mode: 'stamp' })).rejects.toThrow(/old doesn't contain origin\/main: merge or rebase it first/);
    expect(mainWrites(r.commands)).toEqual([]);
    expect(writes(r.fake.calls)).toEqual([]);
  });

  it('stamps nothing when a changed plugin fails its check', async () => {
    const repo = pluginRepo({ alpha: '1.0.0', beta: '1.0.0' });
    const r = runner(repo);
    await r.run();
    out(repo.clone, 'checkout', '-q', '-b', 'topic');
    commit(repo.clone, { 'plugins/alpha/shared/x.ts': 'export const x = 1;\n', 'plugins/beta/shared/x.ts': 'export const x = 1;\n' }, 'fix: both', false);
    const head = out(repo.clone, 'rev-parse', 'HEAD');
    r.failChecks();
    const result = await r.run({ mode: 'stamp' });
    expect(result.failed).toEqual([expect.stringMatching(/^alpha: plugin:check failed at tests .*Nothing was stamped/), expect.stringMatching(/^beta: /)]);
    expect(out(repo.clone, 'rev-parse', 'HEAD')).toBe(head);
    expect(out(repo.clone, 'status', '--porcelain')).toBe('');
  });

  it("stamps a rebuild of a plugin this SDK can't run, and one built for another version only with --sdk-rebuild; publish reports both until then", async () => {
    const [major, minor, patch] = PLUGIN_SDK_VERSION.split('.').map(Number) as [number, number, number];
    const repo = pluginRepo({ alpha: '1.0.0', beta: '1.0.0' });
    const head = mainAt(repo);
    listed(repo, 'alpha', '1.0.0', head, `${major - 1}.0.0`);
    listed(repo, 'beta', '1.0.0', head, `${major}.${minor}.${patch + 1}`);
    const r = runner(repo);
    expect((await r.run()).failed).toEqual([expect.stringMatching(/^alpha: alpha-v1\.0\.0 is built for SDK .*stamp a rebuild in a pull request \(--stamp\)/)]);
    expect((await r.run({ sdkRebuild: true })).failed).toHaveLength(2);
    expect((await r.land('rebuild', () => undefined)).stamped).toEqual(['alpha-v1.0.1']);
    expect(await r.run()).toEqual({ released: ['alpha-v1.0.1'], stamped: [], failed: [] });
    expect((await r.land('rebuild-all', () => undefined, { sdkRebuild: true })).stamped).toEqual(['beta-v1.0.1']);
    expect(await r.run({ sdkRebuild: true })).toEqual({ released: ['beta-v1.0.1'], stamped: [], failed: [] });
    const index = parseMarketplaceIndex(r.fake.index());
    expect(index.plugins.map((p) => p.releases[0]!.sdk)).toEqual([PLUGIN_SDK_VERSION, PLUGIN_SDK_VERSION]);
  });
});

describe('plugin:release-changed --check (pull request CI)', { timeout: RUN_TEST_TIMEOUT_MS }, () => {
  it('fails a changed plugin until its version is stamped, writing nothing', async () => {
    const repo = pluginRepo({ alpha: '1.0.0', beta: '1.0.0' });
    const r = runner(repo);
    await r.run();
    out(repo.clone, 'checkout', '-q', '-b', 'topic');
    commit(repo.clone, { 'plugins/alpha/shared/x.ts': 'export const x = 1;\n' }, 'fix(alpha): x', false);
    // CI checks out the pull request's merge commit, detached.
    out(repo.clone, 'checkout', '-q', '--detach');
    const calls = r.fake.calls.length;
    expect(await r.run({ mode: 'check' })).toEqual({ released: [], stamped: [], failed: [expect.stringMatching(/^alpha: changed since alpha-v1\.0\.0 without a raised version; stamp it/)] });
    out(repo.clone, 'checkout', '-q', 'topic');
    await r.run({ mode: 'stamp' });
    out(repo.clone, 'checkout', '-q', '--detach');
    expect(await r.run({ mode: 'check' })).toEqual({ released: [], stamped: [], failed: [] });
    expect(writes(r.fake.calls.slice(calls))).toEqual([]);
  });

  it("notes, without failing, a change main already holds that this pull request didn't make", async () => {
    const repo = pluginRepo({ alpha: '1.0.0', beta: '1.0.0' });
    const r = runner(repo);
    await r.run();
    pull(repo.other);
    commit(repo.other, { 'plugins/beta/shared/x.ts': 'export const x = 1;\n' }, 'fix(beta): landed unstamped');
    pull(repo.clone);
    out(repo.clone, 'checkout', '-q', '-b', 'topic');
    commit(repo.clone, { 'README.md': 'Docs.\n' }, 'docs: readme', false);
    const lines: string[] = [];
    expect(await r.run({ mode: 'check', log: (l) => lines.push(l) })).toEqual({ released: [], stamped: [], failed: [] });
    expect(lines).toContainEqual(expect.stringMatching(/^Note: beta: changed since beta-v1\.0\.0/));
  });
});

describe('plugin:release-changed with an old pending intent on a pull request', { timeout: RUN_TEST_TIMEOUT_MS }, () => {
  it('fails an edit made after the intent until it is stamped past it, and accepts a branch that raised it already', async () => {
    const repo = pluginRepo({ alpha: '1.0.0' });
    listed(repo, 'alpha', '1.0.0', mainAt(repo));
    pull(repo.other);
    commit(repo.other, { [sharedFile('alpha')]: readFileSync(join(repo.other, sharedFile('alpha')), 'utf8').replace("'1.0.0'", "'1.0.1'") }, 'chore(release): alpha-v1.0.1');
    pull(repo.clone);
    const r = runner(repo);
    out(repo.clone, 'checkout', '-q', '-b', 'topic');
    commit(repo.clone, { 'plugins/alpha/shared/x.ts': 'export const x = 1;\n' }, 'fix(alpha): after the intent', false);
    expect((await r.run({ mode: 'check' })).failed).toEqual([expect.stringMatching(/^alpha: changed since alpha-v1\.0\.1 was tagged without a raised version/)]);
    expect((await r.run({ mode: 'stamp' })).stamped).toEqual(['alpha-v1.0.2']);
    expect(await r.run({ mode: 'check' })).toEqual({ released: [], stamped: [], failed: [] });
  });
});

describe('plugin:release-changed arguments', () => {
  it.each([[[]], [['dir']], [['dir', '--repo']], [['dir', '--repo', REPO, '--dryrun']], [['dir', 'extra', '--repo', REPO]], [['dir', '--repo', REPO, '--only']], [['dir', '--repo', REPO, '--stamp', '--check']]])('refuses arguments %j', async (args) => {
    const error = console.error;
    console.error = quiet;
    try {
      expect(await main(args)).toBe(1);
    } finally {
      console.error = error;
    }
  });
});
