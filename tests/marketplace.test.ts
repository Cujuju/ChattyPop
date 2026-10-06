// Marketplace client: repos and tokens, what GitHub is sent, and what an install stages for the next start.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INSTALLED_PLUGINS_DIR, REMOVED_DIR, STAGED_DIR } from '@shared/installedPlugins';
import { tokenFile } from '../src/main/marketplace/marketplaces';
import { INCOMING_DIR } from '../src/main/marketplace/staging';
import { API, ASSET_ID, REPO, TOKEN, builtFiles, filesToTar, fixture, sha, tarGz, writeFiles } from './marketplaceHarness';

const release = { kind: 'release', version: '1.0.0' } as const;
const plugins = (profile: string, ...parts: string[]): string => join(profile, INSTALLED_PLUGINS_DIR, ...parts);
const readdir = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : []);
const stagedJson = (profile: string, id: string, file: string): Record<string, unknown> => JSON.parse(readFileSync(plugins(profile, STAGED_DIR, id, file), 'utf8'));

describe('marketplaces and tokens', () => {
  it('adds after reading the index, keeps the token in secrets only, and removes both', async () => {
    const f = fixture();
    f.gh.privateToken = TOKEN;
    const m = f.make();
    await expect(m.add(REPO, null)).rejects.toThrow(/not found, or GitHub without a token can't read it/);
    expect(existsSync(join(f.profile, 'marketplaces.json'))).toBe(false);
    await m.add(REPO, TOKEN);
    expect(readFileSync(join(f.profile, 'marketplaces.json'), 'utf8')).not.toContain(TOKEN);
    expect(f.secrets.get(tokenFile(REPO))).toBe(TOKEN);
    const { marketplaces } = await m.state();
    expect(marketplaces).toEqual([{ repo: REPO, hasToken: true, builtIn: false, plugins: f.index.plugins, error: null, fetchedAt: 1 }]);
    await expect(m.add('OWNER/Market', null)).rejects.toThrow(/already added/);
    await m.remove(REPO);
    expect(f.secrets.size).toBe(0);
    expect((await m.state()).marketplaces).toEqual([]);
  });

  it('refuses a malformed repo or token before any request', async () => {
    const f = fixture();
    const m = f.make();
    await expect(m.add('not a repo', null)).rejects.toThrow(/owner\/name/);
    await expect(m.add(REPO, 'two words')).rejects.toThrow(/letters, digits and underscores/);
    await expect(m.add(REPO, `${TOKEN}\0`)).rejects.toThrow(/letters, digits and underscores/);
    expect(f.gh.calls).toEqual([]);
  });

  it('starts unfetched after a restart, then refresh records each failure as the listing error', async () => {
    const f = fixture();
    await f.make().add(REPO, null);
    const m = f.make();
    expect((await m.state()).marketplaces[0]).toMatchObject({ plugins: [], error: null, fetchedAt: null });
    f.gh.privateToken = TOKEN;
    await m.refresh();
    expect((await m.state()).marketplaces[0]!.error).toMatch(/not found, or GitHub without a token can't read it/);
  });

  it('lists every release without a token while the anonymous API quota is spent (a shared IP)', async () => {
    const f = fixture();
    const m = f.make();
    f.gh.routes.set(`${API}/repos/${REPO}`, () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }));
    await m.add(REPO, null);
    expect((await m.state()).marketplaces[0]).toMatchObject({ error: null, plugins: [{ id: 'demo', releases: [{ version: '1.0.0' }] }] });
    await m.install(REPO, 'demo', release);
  });

  it('setToken replaces or clears the token and refetches', async () => {
    const f = fixture();
    const m = f.make();
    await m.add(REPO, null);
    f.gh.privateToken = TOKEN;
    await m.setToken(REPO, TOKEN);
    expect((await m.state()).marketplaces[0]).toMatchObject({ hasToken: true, error: null });
    await m.setToken(REPO, null);
    expect((await m.state()).marketplaces[0]).toMatchObject({ hasToken: false, error: expect.stringMatching(/not found/) });
  });

  it('sends the token only to api.github.com, never on a redirect, and no error carries it', async () => {
    const f = fixture();
    const m = f.make();
    await m.add(REPO, TOKEN);
    await m.install(REPO, 'demo', release);
    const authed = f.gh.calls.filter((c) => 'authorization' in c.headers);
    expect(authed.length).toBeGreaterThan(0);
    expect(authed.every((c) => new URL(c.url).host === 'api.github.com')).toBe(true);
    expect(f.gh.calls.filter((c) => c.url.includes('example-cdn')).every((c) => !('authorization' in c.headers))).toBe(true);
    expect(f.gh.calls.every((c) => c.redirect === 'manual')).toBe(true);
    // A redirect back to the API still goes without the token.
    f.gh.routes.set(`${API}/repos/${REPO}/releases/assets/${ASSET_ID}`, () => new Response(null, { status: 301, headers: { location: `${API}/elsewhere` } }));
    const before = f.gh.calls.length;
    const err = await m.install(REPO, 'demo', release).catch((e: Error) => e);
    expect(String(err)).not.toContain(TOKEN);
    expect(f.gh.calls.slice(before).find((c) => c.url === `${API}/elsewhere`)?.headers['authorization']).toBeUndefined();
  });

  it('reports a failed request by its code, never its message, which can quote the token', async () => {
    const f = fixture();
    f.gh.privateToken = TOKEN;
    const m = f.make();
    await m.add(REPO, TOKEN);
    f.gh.routes.set(`${API}/repos/${REPO}/contents/marketplace.json`, () => {
      throw Object.assign(new TypeError(`invalid header value "Bearer ${TOKEN}"`), { cause: { code: 'ECONNRESET' } });
    });
    await m.refresh();
    const error = (await m.state()).marketplaces[0]!.error;
    expect(error).toMatch(/couldn't reach GitHub \(ECONNRESET\)/);
    expect(error).not.toContain(TOKEN);
  });
});

describe('release installs', () => {
  it('stages a checked build with source.json and clears a pending removal', async () => {
    const f = fixture();
    const m = f.make();
    await m.add(REPO, null);
    mkdirSync(plugins(f.profile, REMOVED_DIR), { recursive: true });
    writeFileSync(plugins(f.profile, REMOVED_DIR, 'demo'), '');
    await m.install(REPO, 'demo', release);
    expect(stagedJson(f.profile, 'demo', 'source.json')).toEqual({ kind: 'release', repo: REPO, tag: 'demo-v1.0.0', sha256: sha(f.asset), installedAt: 1 });
    expect(existsSync(plugins(f.profile, STAGED_DIR, 'demo', 'node', 'shared.js'))).toBe(true);
    expect(existsSync(plugins(f.profile, REMOVED_DIR, 'demo'))).toBe(false);
    expect(readdir(plugins(f.profile, INCOMING_DIR))).toEqual([]);
  });

  it("installs without a token on one API call, the default branch: the index and assets come from GitHub's file hosts", async () => {
    // Tests marketplace access without per-install anonymous API queries.
    const f = fixture();
    const m = f.make();
    await m.add(REPO, null);
    for (let i = 0; i < 3; i++) await m.install(REPO, 'demo', release);
    expect(f.gh.calls.filter((c) => new URL(c.url).host === 'api.github.com').map((c) => c.url)).toEqual([`${API}/repos/${REPO}`]);
  });

  it('refuses a download whose sha256 differs from the index', async () => {
    const f = fixture();
    f.index.plugins[0]!.releases[0]!.sha256 = '0'.repeat(64);
    f.listing(f.index);
    const m = f.make();
    await m.add(REPO, null);
    await expect(m.install(REPO, 'demo', release)).rejects.toThrow(/doesn't match the sha256/);
    expect(existsSync(plugins(f.profile, STAGED_DIR, 'demo'))).toBe(false);
  });

  it('refuses an SDK mismatch before downloading', async () => {
    const f = fixture(undefined, '99.0.0');
    const m = f.make();
    await m.add(REPO, null);
    await expect(m.install(REPO, 'demo', release)).rejects.toThrow(/plugin SDK 99.0.0/);
    expect(f.gh.calls.some((c) => c.url.includes('/releases/'))).toBe(false);
  });

  it.each([
    ['a path outside the folder', [{ path: 'node/../../evil.js', content: 'x' }]],
    ['an absolute path', [{ path: '/evil.js', content: 'x' }]],
    ['a SymbolicLink', [{ path: 'link', type: '2' as const, link: '/etc/passwd' }]],
    ['a Link', [{ path: 'hard', type: '1' as const, link: 'plugin.json' }]],
  ])('refuses an archive holding %s, leaving nothing behind', async (what, extra) => {
    const f = fixture(tarGz([...filesToTar(builtFiles()), ...extra]));
    const m = f.make();
    await m.add(REPO, null);
    await expect(m.install(REPO, 'demo', release)).rejects.toThrow(`The archive holds ${what} `);
    expect(existsSync(plugins(f.profile, STAGED_DIR, 'demo'))).toBe(false);
    expect(readdir(plugins(f.profile, INCOMING_DIR))).toEqual([]);
  });

  it.each([
    ['id', builtFiles('other'), /plugin other, not demo/],
    ['version', builtFiles('demo', '2.0.0'), /demo 2.0.0, not 1.0.0/],
  ])('refuses a build whose %s differs from the index', async (_what, files, error) => {
    const f = fixture(tarGz(filesToTar(files)));
    const m = f.make();
    await m.add(REPO, null);
    await expect(m.install(REPO, 'demo', release)).rejects.toThrow(error);
  });

  it('replaces an older staged copy', async () => {
    const f = fixture();
    const m = f.make();
    await m.add(REPO, null);
    writeFiles(plugins(f.profile, STAGED_DIR, 'demo'), { 'stale.txt': 'old', ...builtFiles('demo', '0.9.0') });
    await m.install(REPO, 'demo', release);
    expect(existsSync(plugins(f.profile, STAGED_DIR, 'demo', 'stale.txt'))).toBe(false);
    expect(stagedJson(f.profile, 'demo', 'plugin.json')['version']).toBe('1.0.0');
  });
});

