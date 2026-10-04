// Plugin release state (scripts/pluginReleaseState.ts, docs/plugin-architecture.md §16): each plugin's manifest version
// on main against its newest listed release, read from a real repo's history.
import { describe, expect, it } from 'vitest';
import { nextVersion, raisedVersion, readStates } from '../scripts/pluginReleaseState';
import { GIT_TEST_TIMEOUT_MS, commit, git, listed, out, pluginRepo, pull, sharedFile, sharedSource } from './pluginReleaseHarness';

const fetch = (dir: string): void => void out(dir, 'fetch', '-q', '--tags', 'origin');
const stateOf = (dir: string, id: string) => {
  fetch(dir);
  return readStates(git, dir, [id])[0]!;
};

/** A repo with plugin alpha released at 1.0.0 (beta beside it, unreleased). */
function releasedA() {
  const repo = pluginRepo({ alpha: '1.0.0', beta: '1.0.0' });
  listed(repo, 'alpha', '1.0.0', out(repo.clone, 'rev-parse', 'HEAD'));
  return repo;
}

describe('plugin release state', { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  it('raises versions: minor resets the patch', () => {
    expect(nextVersion('1.2.3', 'patch')).toBe('1.2.4');
    expect(nextVersion('1.2.3', 'minor')).toBe('1.3.0');
    expect(raisedVersion('1.2.0', ['patch', 'minor', 'patch'])).toBe('1.3.1');
  });

  it('is settled and unchanged after its release, whatever else changes', () => {
    const repo = releasedA();
    commit(repo.other, { 'README.md': 'More.\n', [sharedFile('beta')]: sharedSource('beta', '1.0.0').replace('Fixture', 'Fixture!') }, 'feat(beta): elsewhere');
    expect(stateOf(repo.clone, 'alpha')).toMatchObject({ kind: 'settled', version: '1.0.0', changed: null });
  });

  it.each([
    ['fix(alpha): words', 'patch'],
    ['feat(alpha): more', 'minor'],
    ['feat(alpha)!: break', 'minor'],
    ['feat: unscoped', 'minor'],
  ] as const)('a change by "%s" calls for a %s release', (subject, bump) => {
    const repo = releasedA();
    commit(repo.other, { 'plugins/alpha/shared/extra.ts': 'export const x = 1;\n' }, subject);
    expect(stateOf(repo.clone, 'alpha')).toMatchObject({ kind: 'settled', changed: [bump] });
  });

  it('bumps once per commit to its folder, oldest first, merges and other folders aside', () => {
    const repo = releasedA();
    commit(repo.other, { 'plugins/alpha/shared/a.ts': 'export const a = 1;\n' }, 'fix(alpha): a', false);
    out(repo.other, 'checkout', '-q', '-b', 'side');
    commit(repo.other, { 'plugins/alpha/shared/b.ts': 'export const b = 1;\n' }, 'feat(alpha): b', false);
    out(repo.other, 'checkout', '-q', 'main');
    commit(repo.other, { 'README.md': 'More.\n' }, 'feat: elsewhere', false);
    out(repo.other, 'merge', '-q', '--no-ff', '-m', "Merge branch 'side'", 'side');
    commit(repo.other, { 'plugins/alpha/shared/c.ts': 'export const c = 1;\n' }, 'fix(alpha): c');
    expect(stateOf(repo.clone, 'alpha')).toMatchObject({ kind: 'settled', changed: ['patch', 'minor', 'patch'] });
  });

  it('counts an edit made only in a merge', () => {
    const repo = releasedA();
    out(repo.other, 'checkout', '-q', '-b', 'side');
    commit(repo.other, { 'side.txt': 'side\n' }, 'docs: side', false);
    out(repo.other, 'checkout', '-q', 'main');
    commit(repo.other, { 'main.txt': 'main\n' }, 'docs: main', false);
    out(repo.other, 'merge', '--no-ff', '--no-commit', 'side');
    commit(repo.other, { 'plugins/alpha/shared/extra.ts': 'export const merged = 1;\n' }, "Merge branch 'side'");
    expect(stateOf(repo.clone, 'alpha')).toMatchObject({ kind: 'settled', changed: ['patch'] });
  });

  it('finds a pending version at its intent commit after listing commits moved main', () => {
    const repo = releasedA();
    const intent = commit(repo.other, { [sharedFile('alpha')]: sharedSource('alpha', '1.0.1') }, 'chore(release): alpha-v1.0.1');
    listed(repo, 'beta', '1.0.0', intent);
    commit(repo.other, { 'plugins/alpha/shared/extra.ts': 'export const later = 1;\n' }, 'fix(alpha): later');
    expect(stateOf(repo.clone, 'alpha')).toEqual({ id: 'alpha', kind: 'pending', version: '1.0.1', target: intent });
    expect(stateOf(repo.clone, 'beta')).toMatchObject({ kind: 'settled', version: '1.0.0' });
  });

  it('finishes an intent a later hand-raised version passed over, before the new version', () => {
    const repo = releasedA();
    const intent = commit(repo.other, { [sharedFile('alpha')]: sharedSource('alpha', '1.0.1') }, 'chore(release): alpha-v1.0.1');
    commit(repo.other, { [sharedFile('alpha')]: sharedSource('alpha', '2.0.0') }, 'feat(alpha)!: 2.0');
    expect(stateOf(repo.clone, 'alpha')).toEqual({ id: 'alpha', kind: 'pending', version: '1.0.1', target: intent });
    listed(repo, 'alpha', '1.0.1', intent);
    expect(stateOf(repo.clone, 'alpha')).toEqual({ id: 'alpha', kind: 'unstamped', version: '2.0.0' });
  });

  it('is unstamped when unlisted or raised by hand, without an intent commit', () => {
    const repo = releasedA();
    commit(repo.other, { [sharedFile('alpha')]: sharedSource('alpha', '2.0.0') }, 'feat(alpha)!: 2.0');
    expect(stateOf(repo.clone, 'alpha')).toEqual({ id: 'alpha', kind: 'unstamped', version: '2.0.0' });
    expect(stateOf(repo.clone, 'beta')).toEqual({ id: 'beta', kind: 'unstamped', version: '1.0.0' });
  });

  it('is broken when its version or newest listed tag contradicts the index', () => {
    const lower = releasedA();
    commit(lower.other, { [sharedFile('alpha')]: sharedSource('alpha', '0.9.0') }, 'fix(alpha): down');
    expect(stateOf(lower.clone, 'alpha')).toMatchObject({ kind: 'broken', reason: expect.stringMatching(/below its newest listed release 1\.0\.0/) });

    const missing = releasedA();
    out(missing.bare, 'tag', '-d', 'alpha-v1.0.0');
    out(missing.clone, 'tag', '-d', 'alpha-v1.0.0');
    expect(stateOf(missing.clone, 'alpha')).toMatchObject({ kind: 'broken', reason: expect.stringMatching(/no tag alpha-v1\.0\.0/) });

    const offMain = pluginRepo({ alpha: '1.0.0' });
    out(offMain.other, 'checkout', '-q', '-b', 'side');
    const side = commit(offMain.other, { 'side.txt': 'x\n' }, 'docs: side', false);
    out(offMain.other, 'push', '-q', 'origin', 'side');
    out(offMain.other, 'checkout', '-q', 'main');
    listed(offMain, 'alpha', '1.0.0', side);
    expect(stateOf(offMain.clone, 'alpha')).toMatchObject({ kind: 'broken', reason: expect.stringMatching(/not on main/) });

    const wrong = pluginRepo({ alpha: '0.9.0' });
    const old = out(wrong.clone, 'rev-parse', 'HEAD');
    commit(wrong.other, { [sharedFile('alpha')]: sharedSource('alpha', '1.0.0') }, 'fix(alpha): 1.0');
    listed(wrong, 'alpha', '1.0.0', old);
    expect(stateOf(wrong.clone, 'alpha')).toMatchObject({ kind: 'broken', reason: expect.stringMatching(/descriptor is alpha 0\.9\.0/) });
  });

  it('refuses an unknown --only id', () => {
    const repo = pluginRepo({ alpha: '1.0.0' });
    pull(repo.clone);
    expect(() => readStates(git, repo.clone, ['zz'])).toThrow(/No plugin folder on main for zz/);
  });
});
