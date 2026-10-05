// `pnpm plugin:release-changed` (scripts/pluginReleaseChanged.ts, docs/plugin-architecture.md §16) on a real plugin
// repo and a fake gh: pending versions finish first, changed plugins are stamped in one pushed intent commit and
// published there, and every failure leaves a state the next plain run finishes.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLUGIN_SDK_VERSION } from '@shared/installedPlugins';
import { main, releaseChanged, type ReleaseChangedOptions } from '../scripts/pluginReleaseChanged';
import { manifestVersion } from '../scripts/pluginScan/manifest';
import type { Git } from '../scripts/pluginRelease';
import { GIT_TEST_TIMEOUT_MS, REPO, commit, fakeAsset, fakeGh, git, listed, out, pluginRepo, pull, sharedFile, writes, type PluginRepo } from './pluginReleaseHarness';

const quiet = (): void => undefined;
/** Two runs, each evaluating stamped descriptors and driving a few dozen git commands. */
const RUN_TEST_TIMEOUT_MS = 2 * GIT_TEST_TIMEOUT_MS;

/** The version `id`'s descriptor holds at `rev`. */
const versionAt = (dir: string, rev: string, id: string): string => manifestVersion({ rel: sharedFile(id), text: out(dir, 'show', `${rev}:${sharedFile(id)}`) }).version;
const subjects = (repo: PluginRepo): string[] => out(repo.bare, 'log', '--format=%s', 'main').split('\n');
const tagAt = (repo: PluginRepo, tag: string): string => out(repo.bare, 'rev-parse', `${tag}^{commit}`);

/** A release run over `repo` with a fake gh, a passing (or `checkFails`) check and fake asset builds. */
function runner(repo: PluginRepo) {
  const fake = fakeGh(repo.bare);
  const checked: string[] = [];
  let checkFails = false;
  const run = (o: Partial<ReleaseChangedOptions> = {}) =>
    releaseChanged({
      repoDir: repo.clone, repo: REPO, dryRun: false, sdkRebuild: false, gh: fake.gh, git, log: quiet,
      check: async ({ pluginDir }) => (checked.push(pluginDir), checkFails ? 'tests' : null),
      buildAsset: (id, target, workDir) => fakeAsset(workDir, id, versionAt(repo.clone, target, id)),
      ...o,
    });
  return { fake, checked, run, failChecks: () => void (checkFails = true) };
}

describe('plugin:release-changed', { timeout: RUN_TEST_TIMEOUT_MS }, () => {
  it('gives a first release an empty intent commit, then publishes and lists it there', async () => {
    const repo = pluginRepo({ alpha: '1.0.0' });
    const r = runner(repo);
    expect(await r.run()).toEqual({ released: ['alpha-v1.0.0'], failed: [] });
    expect(subjects(repo).slice(0, 2)).toEqual(['release: alpha-v1.0.0', 'chore(release): alpha-v1.0.0']);
    expect(tagAt(repo, 'alpha-v1.0.0')).toBe(out(repo.bare, 'rev-parse', 'main~1'));
    expect(out(repo.bare, 'diff', '--name-only', 'main~2', 'main~1')).toBe('');
    // The clone is left at main, ready for the next run.
    expect(out(repo.clone, 'rev-parse', 'HEAD')).toBe(out(repo.bare, 'rev-parse', 'main'));
    expect(await r.run()).toEqual({ released: [], failed: [] });
  });

  it('resumes an interrupted first release at its intent commit, then releases the edit made since', async () => {
    const repo = pluginRepo({ alpha: '1.0.0' });
    const r = runner(repo);
    r.fake.failNext('release create', { code: 1, stderr: 'network down' });
    const first = await r.run();
    expect(first.released).toEqual([]);
    expect(first.failed).toEqual([expect.stringMatching(/^alpha-v1\.0\.0: gh release create failed: network down/)]);
    const intent = out(repo.bare, 'rev-parse', 'main');
    pull(repo.other);
    commit(repo.other, { 'plugins/alpha/shared/extra.ts': 'export const later = 1;\n' }, 'fix(alpha): later');
    pull(repo.clone);
    expect(await r.run()).toEqual({ released: ['alpha-v1.0.0', 'alpha-v1.0.1'], failed: [] });
    expect(tagAt(repo, 'alpha-v1.0.0')).toBe(intent);
    expect(versionAt(repo.bare, tagAt(repo, 'alpha-v1.0.1'), 'alpha')).toBe('1.0.1');
    expect(subjects(repo).filter((s) => s.startsWith('chore(release)'))).toEqual(['chore(release): alpha-v1.0.1', 'chore(release): alpha-v1.0.0']);
  });

  it('stamps one release raised by each commit, the stamp the only change in its intent commit', async () => {
    const repo = pluginRepo({ alpha: '1.0.0', beta: '1.0.0' });
    const head = out(repo.clone, 'rev-parse', 'HEAD');
    listed(repo, 'alpha', '1.0.0', head);
    listed(repo, 'beta', '1.0.0', head);
    pull(repo.other);
    commit(repo.other, { 'plugins/alpha/shared/extra.ts': 'export const more = 1;\n' }, 'feat(alpha): more', false);
    commit(repo.other, { 'plugins/alpha/shared/extra.ts': 'export const more = 2;\n' }, 'fix(alpha): more');
    pull(repo.clone);
    const r = runner(repo);
    expect(await r.run()).toEqual({ released: ['alpha-v1.1.1'], failed: [] });
    const stamp = tagAt(repo, 'alpha-v1.1.1');
    expect(out(repo.bare, 'diff', '--name-only', `${stamp}~1`, stamp)).toBe(sharedFile('alpha'));
    expect(out(repo.bare, 'log', '-1', '--format=%s', stamp)).toBe('chore(release): alpha-v1.1.1');
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
      const before = out(repo.bare, 'rev-parse', 'main');
      await expect(r.run()).rejects.toThrow(why);
      expect(r.fake.calls).toEqual([]);
      expect(out(repo.bare, 'rev-parse', 'main')).toBe(before);
    }
  });

  it('stamps nothing when a changed plugin fails its check', async () => {
    const repo = pluginRepo({ alpha: '1.0.0', beta: '1.0.0' });
    const r = runner(repo);
    r.failChecks();
    const before = out(repo.bare, 'rev-parse', 'main');
    const result = await r.run();
    expect(result.failed).toEqual([expect.stringMatching(/^alpha: plugin:check failed at tests .*Nothing was stamped/), expect.stringMatching(/^beta: /)]);
    expect(out(repo.bare, 'rev-parse', 'main')).toBe(before);
    expect(r.fake.calls).toEqual([]);
  });

  it('fails with nothing pending when another push beats the intent commit', async () => {
    const repo = pluginRepo({ alpha: '1.0.0' });
    const before = out(repo.clone, 'rev-parse', 'HEAD');
    let raced = false;
    const racing: Git = (dir, args) => {
      if (args[0] === 'push' && !raced) {
        raced = true;
        pull(repo.other);
        commit(repo.other, { 'x.txt': 'x\n' }, 'docs: first');
      }
      return git(dir, args);
    };
    const r = runner(repo);
    await expect(r.run({ git: racing })).rejects.toThrow(/Pushing the release intent was rejected; nothing is pending/);
    expect(out(repo.clone, 'rev-parse', 'HEAD')).toBe(before);
    expect(out(repo.clone, 'status', '--porcelain')).toBe('');
    expect(subjects(repo)[0]).toBe('docs: first');
    expect(writes(r.fake.calls)).toEqual([]);
  });

  it('finishes only the failed plugin of a batch on the next plain run', async () => {
    const repo = pluginRepo({ alpha: '1.0.0', beta: '1.0.0' });
    const head = out(repo.clone, 'rev-parse', 'HEAD');
    listed(repo, 'alpha', '1.0.0', head);
    listed(repo, 'beta', '1.0.0', head);
    pull(repo.other);
    commit(repo.other, { 'plugins/alpha/shared/x.ts': 'export const x = 1;\n', 'plugins/beta/shared/x.ts': 'export const x = 1;\n' }, 'fix: both');
    pull(repo.clone);
    const r = runner(repo);
    r.fake.failNext('release create beta-v1.0.1', { code: 1, stderr: 'upload failed' });
    expect(await r.run()).toEqual({ released: ['alpha-v1.0.1'], failed: [expect.stringMatching(/^beta-v1\.0\.1: /)] });
    const calls = r.fake.calls.length;
    expect(await r.run()).toEqual({ released: ['beta-v1.0.1'], failed: [] });
    expect(writes(r.fake.calls.slice(calls)).filter((c) => c.includes('alpha'))).toEqual([]);
    expect(subjects(repo).filter((s) => s.startsWith('chore(release)'))).toEqual(['chore(release): alpha-v1.0.1, beta-v1.0.1']);
    expect(tagAt(repo, 'beta-v1.0.1')).toBe(tagAt(repo, 'alpha-v1.0.1'));
  });

  it("rebuilds a plugin this SDK can't run on any run, once; one it can run but built for another version, only with --sdk-rebuild", async () => {
    const [major, minor, patch] = PLUGIN_SDK_VERSION.split('.').map(Number) as [number, number, number];
    const repo = pluginRepo({ alpha: '1.0.0', beta: '1.0.0' });
    const head = out(repo.clone, 'rev-parse', 'HEAD');
    listed(repo, 'alpha', '1.0.0', head, `${major - 1}.0.0`);
    listed(repo, 'beta', '1.0.0', head, `${major}.${minor}.${patch + 1}`);
    const r = runner(repo);
    expect(await r.run()).toEqual({ released: ['alpha-v1.0.1'], failed: [] });
    expect(await r.run()).toEqual({ released: [], failed: [] });
    expect(await r.run({ sdkRebuild: true })).toEqual({ released: ['beta-v1.0.1'], failed: [] });
    expect(await r.run({ sdkRebuild: true })).toEqual({ released: [], failed: [] });
    const index = JSON.parse(out(repo.bare, 'show', 'main:marketplace.json')) as { plugins: { releases: { sdk: string }[] }[] };
    expect(index.plugins.map((p) => p.releases[0]!.sdk)).toEqual([PLUGIN_SDK_VERSION, PLUGIN_SDK_VERSION]);
  });

  it('checks but publishes nothing on a dry run', async () => {
    const repo = pluginRepo({ alpha: '1.0.0' });
    const r = runner(repo);
    const before = out(repo.bare, 'rev-parse', 'main');
    expect(await r.run({ dryRun: true })).toEqual({ released: [], failed: [] });
    expect(r.checked).toHaveLength(1);
    expect(r.fake.calls).toEqual([]);
    expect(out(repo.bare, 'rev-parse', 'main')).toBe(before);
    expect(out(repo.clone, 'rev-parse', 'HEAD')).toBe(before);
  });

  it.each([[[]], [['dir']], [['dir', '--repo']], [['dir', '--repo', REPO, '--dryrun']], [['dir', 'extra', '--repo', REPO]], [['dir', '--repo', REPO, '--only']]])('refuses arguments %j', async (args) => {
    const error = console.error;
    console.error = quiet;
    try {
      expect(await main(args)).toBe(1);
    } finally {
      console.error = error;
    }
  });
});
