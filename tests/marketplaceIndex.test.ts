// Where the client reads a marketplace's index: the index release's asset first, else the default branch's marketplace.json, parsed alike.
import { describe, expect, it } from 'vitest';
import { compareVersions } from '@shared/installedPlugins';
import type { MarketplaceIndex } from '@shared/marketplace';
import { GitHub } from '../src/main/marketplace/github';
import { API, REPO, TOKEN, fixture } from './marketplaceHarness';

const SHA = 'b'.repeat(64);
const rel = (version: string) => ({ version, tag: `demo-v${version}`, asset: `demo-${version}.tar.gz`, sha256: SHA, sdk: '1.0.0' });
/** An index newer than the fixture's main file: releases out of order and no `source`, so parsing sorts them and fills the default folder. */
const newer = { format: 1, plugins: [{ id: 'demo', name: 'Demo', description: '', releases: [rel('1.0.0'), rel('1.2.0'), rel('1.10.0')] }] };
const newest = (index: MarketplaceIndex): string => index.plugins[0]!.releases[0]!.version;

describe.each([
  ['without a token', null],
  ['with a token', TOKEN],
] as const)('GitHub.index %s', (_, token) => {
  it('reads the index release asset when there is one', async () => {
    const f = fixture();
    f.indexAsset(newer);
    const index = await new GitHub(f.gh.fetch).index(REPO, token);
    expect(index.plugins[0]!.releases.map((r) => r.version)).toEqual(['1.10.0', '1.2.0', '1.0.0']);
    expect(newest(index)).toBe('1.10.0');
    expect(compareVersions(newest(index), newest(f.index))).toBeGreaterThan(0);
  });

  it('parses an index the same from either source', async () => {
    const asset = fixture();
    asset.indexAsset(newer);
    const file = fixture();
    file.listing(newer);
    expect(await new GitHub(asset.gh.fetch).index(REPO, token)).toEqual(await new GitHub(file.gh.fetch).index(REPO, token));
    expect((await new GitHub(file.gh.fetch).index(REPO, token)).plugins[0]!.source).toEqual({ path: 'plugins/demo', branch: 'main' });
  });

  it('falls back to the default branch file when the release or its asset is missing', async () => {
    const f = fixture();
    expect(await new GitHub(f.gh.fetch).index(REPO, token)).toEqual(f.index);
    f.gh.json(`${API}/repos/${REPO}/releases/tags/marketplace`, { assets: [] });
    expect(await new GitHub(f.gh.fetch).index(REPO, token)).toEqual(f.index);
  });

  it.each([
    ['not JSON', '{ not json'],
    ['in a format this host does not read', { format: 2, plugins: [] }],
    ['listing a version twice', { format: 1, plugins: [{ id: 'demo', name: 'Demo', description: '', releases: [rel('1.0.0'), rel('1.0.0')] }] }],
  ])('falls back to the default branch file when the asset is %s', async (_, body) => {
    const f = fixture();
    f.indexAsset(body);
    expect(await new GitHub(f.gh.fetch).index(REPO, token)).toEqual(f.index);
  });

  it('reports the default branch file error when both are missing, as before the release existed', async () => {
    const before = fixture();
    before.gh.routes.delete(`${API}/repos/${REPO}/contents/marketplace.json`);
    before.gh.routes.delete(`https://raw.githubusercontent.com/${REPO}/HEAD/marketplace.json`);
    const expected = `${REPO} marketplace.json: not found, or ${token ? 'the token' : 'GitHub without a token'} can't read it.`;
    await expect(new GitHub(before.gh.fetch).index(REPO, token)).rejects.toThrow(expected);
    const broken = fixture();
    broken.indexAsset('{ not json');
    broken.gh.routes.delete(`${API}/repos/${REPO}/contents/marketplace.json`);
    broken.gh.routes.delete(`https://raw.githubusercontent.com/${REPO}/HEAD/marketplace.json`);
    await expect(new GitHub(broken.gh.fetch).index(REPO, token)).rejects.toThrow(expected);
  });
});
