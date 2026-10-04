import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appVersion, ARCHIVE_ROOT, type LogEntry, versionFromLog, type VersionBase } from '../appVersion';

let repo: string;
const git = (...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
const commit = (subject: string): string => git('commit', '-q', '--allow-empty', '--no-verify', '-m', subject);

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'cp-version-'));
  git('init', '-q', '-b', 'main');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('appVersion', () => {
  it("continues the archive's version in a history without its root", () => {
    commit('feat: initial public release');
    expect(appVersion(repo, { features: 335, patches: 7 })).toBe('0.336.0');
  });

  it('bumps patch for non-feature commits', () => {
    commit('fix: a');
    commit('docs: b');
    expect(appVersion(repo, null)).toBe('0.0.2');
  });

  it('bumps minor for a feature and resets patch', () => {
    commit('fix: a');
    commit('feat: b');
    expect(appVersion(repo, null)).toBe('0.1.0');
    commit('style(ui): c');
    expect(appVersion(repo, null)).toBe('0.1.1');
  });

  it('counts scoped and breaking features', () => {
    commit('feat(ui): a');
    commit('feat!: b');
    commit('feature: not conventional');
    expect(appVersion(repo, null)).toBe('0.2.1');
  });

  it('keeps rising across a merge of patches, and ignores the merge commit', () => {
    commit('feat: base');
    git('checkout', '-q', '-b', 'side');
    commit('fix: side');
    git('checkout', '-q', 'main');
    commit('fix: main');
    expect(appVersion(repo, null)).toBe('0.1.1');
    git('merge', '-q', '--no-ff', '--no-edit', 'side');
    expect(appVersion(repo, null)).toBe('0.1.2');
  });

  it('refuses a checkout without commits', () => {
    expect(() => appVersion(repo, null)).toThrow(/git history/);
  });
});

/** A linear history, oldest subject first, rooted at `root`. */
const linear = (root: string, ...subjects: string[]): LogEntry[] =>
  subjects.map((subject, i) => ({ hash: i === 0 ? root : `c${i}`, parents: i === 0 ? [] : [i === 1 ? root : `c${i - 1}`], subject }));
const base: VersionBase = { features: 334, patches: 1 };

describe('versionFromLog', () => {
  it('ignores the base in the archive history', () => {
    const log = linear(ARCHIVE_ROOT, 'feat: a', 'fix: b');
    expect(versionFromLog(log, base)).toBe(versionFromLog(log, null));
    expect(versionFromLog(log, base)).toBe('0.1.1');
  });

  it('continues the base minor after a feature outside the archive', () => {
    expect(versionFromLog(linear('root', 'feat: initial public release', 'fix: a', 'feat: b', 'fix: c'), base)).toBe('0.336.1');
  });

  it('continues the base patch without a feature outside the archive', () => {
    expect(versionFromLog(linear('root', 'chore: a', 'fix: b'), base)).toBe('0.334.3');
  });

  it('counts from zero without a base', () => {
    expect(versionFromLog(linear('root', 'feat: a', 'fix: b'), null)).toBe('0.1.1');
  });
});
