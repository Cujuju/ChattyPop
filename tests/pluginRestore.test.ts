// First-start restore: which plugins' data remain without them, how they match marketplace listings, and that an offer
// installs through the marketplace client. Also the built-in marketplace and install history.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RULE_SPEC_VERSION } from '@shared/rules';
import { newGates } from '@shared/ruleGates';
import { restoreItems, tableIds, type AbsentPlugin } from '@shared/pluginRestore';
import { PUBLIC_MARKETPLACE, type MarketplaceListing } from '@shared/marketplace';
import { setSetting, type Db } from '../src/core/db';
import { CONTINUITY_KEY, ActivationContinuity } from '../src/core/plugins/continuity';
import { absentPlugins } from '../src/core/plugins/footprints';
import { PLUGINS_DISABLED_KEY } from '../src/core/plugins/host';
import { MARKETPLACES_FILE } from '../src/main/marketplace/marketplaces';
import { applyStaged } from '../src/main/plugins/installed/staged';
import { INSTALLED_PLUGINS_DIR } from '@shared/installedPlugins';
import { REPO, TOKEN, fixture } from './marketplaceHarness';
import { tempDb, tempDir } from './helpers';

const rule = (db: Db, actionType: string, builtin: string | null = null): void => {
  const spec = { v: RULE_SPEC_VERSION, trigger: { type: 'message', config: {} }, gates: newGates(), match: [], narrow: [], actions: [{ id: 'a', type: actionType, config: {} }] };
  db.prepare('INSERT INTO rules (name, spec, position, armed_at, created_at, builtin) VALUES (?, ?, 0, 0, 0, ?)').run('r', JSON.stringify(spec), builtin);
};

/** Each footprint kind, written for plugin `id` alone. */
const FOOTPRINTS: Record<string, (db: Db, dataRoot: string, id: string) => void> = {
  table: (db, _root, id) => db.exec(`CREATE TABLE p_${id}_items (x)`),
  preference: (db, _root, id) => setSetting(db, `plugin.${id}.mode`, 'on'),
  dataDir: (_db, root, id) => mkdirSync(join(root, id), { recursive: true }),
  rule: (db, _root, id) => rule(db, `${id}.apply`),
  managedRule: (db, _root, id) => rule(db, 'host-only', `${id}.digest`),
  disabled: (db, _root, id) => setSetting(db, PLUGINS_DISABLED_KEY, [id]),
  wasOn: (db, _root, id) => setSetting(db, CONTINUITY_KEY, { session: 3, active: { [id]: 2 } }),
};

describe('footprints', () => {
  it.each(Object.keys(FOOTPRINTS))('a %s alone lists its plugin', (kind) => {
    const db = tempDb();
    const root = tempDir();
    FOOTPRINTS[kind]!(db, root, 'tags');
    expect(absentPlugins(db, root, []).map((a) => a.ids)).toEqual([['tags']]);
  });

  it('never lists a loaded (bundled, installed or folder) plugin, whatever data it has', () => {
    const db = tempDb();
    const root = tempDir();
    for (const write of Object.values(FOOTPRINTS)) write(db, root, 'tags');
    FOOTPRINTS['preference']!(db, root, 'summaries');
    expect(absentPlugins(db, root, ['tags'])).toEqual([{ ids: ['summaries'], kinds: ['preference'] }]);
  });

  it('ignores host-managed rules, host rule kinds and host settings', () => {
    const db = tempDb();
    const root = tempDir();
    rule(db, 'host-only', 'notable');
    setSetting(db, 'plugins.something', ['x']);
    expect(absentPlugins(db, root, [])).toEqual([]);
  });

  it('gives a table that fits several ids to a loaded or otherwise found one, else lists every candidate', () => {
    expect(tableIds('p_summaries_digest_runs')).toEqual(['summaries', 'summaries-digest']);
    expect(tableIds('p_tags_tags')).toEqual(['tags']);
    const db = tempDb();
    const root = tempDir();
    db.exec('CREATE TABLE p_summaries_digest_runs (x)');
    expect(absentPlugins(db, root, [])).toEqual([{ ids: ['summaries', 'summaries-digest'], kinds: ['table'] }]);
    expect(absentPlugins(db, root, ['summaries'])).toEqual([]);
    setSetting(db, 'plugin.summaries-digest.mode', 1);
    expect(absentPlugins(db, root, [])).toEqual([{ ids: ['summaries-digest'], kinds: ['preference', 'table'] }]);
  });

  it('keeps an absent plugin in the continuity record, never resumed', () => {
    const db = tempDb();
    setSetting(db, CONTINUITY_KEY, { session: 4, active: { tags: 4, stats: 4 } });
    const continuity = new ActivationContinuity(() => db);
    continuity.start(new Set(['stats']));
    expect(continuity.resumed('stats')).toBe(true);
    expect(absentPlugins(db, tempDir(), ['stats']).map((a) => a.ids)).toEqual([['tags']]);
    // Back in a later build: its old session is a gap.
    const next = new ActivationContinuity(() => db);
    next.start(new Set(['stats', 'tags']));
    expect(next.resumed('tags')).toBe(false);
  });
});

const absent = (...ids: string[]): AbsentPlugin => ({ ids, kinds: ['table'] });

describe('built-in marketplace', () => {
  it('is listed without adding, never stored, and refuses add, removal and a token', async () => {
    const f = fixture();
    const m = f.make(null, [REPO]);
    expect((await m.state()).marketplaces).toEqual([{ repo: REPO, hasToken: false, builtIn: true, plugins: [], error: null, fetchedAt: null }]);
    await m.refresh();
    expect((await m.state()).marketplaces[0]).toMatchObject({ builtIn: true, plugins: f.index.plugins, error: null });
    await expect(m.add(REPO.toUpperCase(), null)).rejects.toThrow(/built in/);
    await expect(m.remove(REPO)).rejects.toThrow(/built in/);
    await expect(m.setToken(REPO, TOKEN)).rejects.toThrow(/needs no token/);
    await m.install(REPO, 'demo', { kind: 'release', version: '1.0.0' });
    expect(f.gh.calls.every((c) => !('authorization' in c.headers))).toBe(true);
    expect((await m.state()).marketplaces).toHaveLength(1);
  });

  it('shows one added before it was built in once, as built in', async () => {
    const f = fixture();
    await f.make().add(REPO, null);
    const m = f.make(null, [REPO]);
    expect((await m.state()).marketplaces.map((l) => [l.repo, l.builtIn])).toEqual([[REPO, true]]);
    await expect(m.remove(REPO)).rejects.toThrow(/built in/);
    expect(readFileSync(join(f.profile, MARKETPLACES_FILE), 'utf8')).toContain(REPO);
  });
});

describe('restore offers', () => {
  it('install the newest compatible release through the marketplace, then drop out once staged', async () => {
    const f = fixture();
    const m = f.make(null, [REPO]);
    await m.refresh();
    const state = await m.state();
    const [item] = restoreItems([absent('demo')], state.marketplaces, state.installed, state.history, []);
    expect(item).toMatchObject({ id: 'demo', name: 'Demo', install: { repo: REPO, choice: { kind: 'release', version: '1.0.0' } }, problem: null });
    await m.install(item!.install!.repo, item!.id, item!.install!.choice);
    const after = await m.state();
    expect(after.installed[0]).toMatchObject({ id: 'demo', pending: { kind: 'install', version: '1.0.0' } });
    expect(after.history).toEqual({ demo: { repo: REPO, uninstalled: false } });
    expect(restoreItems([absent('demo')], after.marketplaces, after.installed, after.history, [])).toEqual([]);
  });

  it('falls back to source, says why it can’t install, and picks the listed candidate of a table', async () => {
    const f = fixture(undefined, '99.0.0');
    const m = f.make(null, [REPO]);
    await m.refresh();
    const { marketplaces } = await m.state();
    expect(restoreItems([absent('demo')], marketplaces, [], {}, [])[0]).toMatchObject({ install: { choice: { kind: 'source' }, version: null } });
    const noSource = marketplaces.map((l) => ({ ...l, plugins: l.plugins.map(({ source: _s, ...p }) => p) }));
    expect(restoreItems([absent('demo')], noSource, [], {}, [])[0]).toMatchObject({ install: null, problem: expect.stringMatching(/plugin SDK 99.0.0/) });
    expect(restoreItems([absent('de', 'demo')], marketplaces, [], {}, [])[0]).toMatchObject({ id: 'demo', name: 'Demo' });
  });

  it('names the marketplace an unlisted plugin came from: its history, else where it moved from the app', () => {
    const owned = 'owner/private';
    const history = { tags: { repo: owned, uninstalled: false } };
    expect(restoreItems([absent('tags')], [], [], history, [])[0]).toMatchObject({
      install: null,
      problem: `Needs marketplace ${owned}.`,
      needs: { repo: owned, added: false },
    });
    // No history: the marketplace it moved to from the app.
    expect(restoreItems([absent('summaries')], [], [], {}, [])[0]).toMatchObject({
      problem: `Needs marketplace ${PUBLIC_MARKETPLACE}.`,
      needs: { repo: PUBLIC_MARKETPLACE, added: false },
    });
    // An added private one that can't be read: a token may help.
    const unreadable: MarketplaceListing[] = [{ repo: owned, hasToken: true, builtIn: false, plugins: [], error: 'Not found (404).', fetchedAt: null }];
    expect(restoreItems([absent('tags')], unreadable, [], history, [])[0]).toMatchObject({ needs: { repo: owned, added: true } });
    // The built-in marketplace is public: a token can't make it readable.
    const builtInDown: MarketplaceListing[] = [{ repo: PUBLIC_MARKETPLACE, hasToken: false, builtIn: true, plugins: [], error: 'Rate limited.', fetchedAt: null }];
    expect(restoreItems([absent('tags')], builtInDown, [], {}, [])[0]).toMatchObject({ problem: expect.stringMatching(/couldn't be read: Rate limited/), needs: null });
    // Another marketplace's plugin of the same id never stands in for the one the data came from.
    const lookalike: MarketplaceListing[] = [{ repo: 'someone/else', hasToken: false, builtIn: false, error: null, fetchedAt: null, plugins: [
      { id: 'summaries', name: 'Not Summaries', description: '', releases: [], source: { path: 'plugins/summaries', branch: 'main' } },
    ] }];
    expect(restoreItems([absent('summaries')], lookalike, [], {}, [])[0]).toMatchObject({ install: null, needs: { repo: PUBLIC_MARKETPLACE, added: false } });
    expect(restoreItems([absent('demo-y')], [{ ...lookalike[0]!, plugins: [{ ...lookalike[0]!.plugins[0]!, id: 'demo-y' }] }], [], {}, [])[0]).toMatchObject({ install: { repo: 'someone/else' } });
    expect(restoreItems([absent('demo-x')], [], [], {}, [])[0]).toMatchObject({ name: 'demo-x', problem: 'Not found in your marketplaces.', needs: null });
    expect(restoreItems([absent('a-b', 'a-b-c')], [], [], {}, [])[0]).toMatchObject({ name: 'a-b or a-b-c' });
  });

  it('leaves out dismissed, uninstalled and installed plugins', async () => {
    const f = fixture();
    const m = f.make(null, [REPO]);
    f.listing(f.index);
    await m.install(REPO, 'demo', { kind: 'release', version: '1.0.0' });
    await m.uninstall('demo');
    const { marketplaces, history } = await m.state();
    expect(history['demo']).toEqual({ repo: REPO, uninstalled: true });
    expect(restoreItems([absent('demo')], marketplaces, [], history, [])).toEqual([]);
    expect(restoreItems([absent('demo')], marketplaces, [], {}, ['demo'])).toEqual([]);
    // Cancelling a staged reinstall keeps the removal: restore still leaves it out.
    await m.install(REPO, 'demo', { kind: 'release', version: '1.0.0' });
    await m.cancel('demo');
    expect((await m.state()).history['demo']).toEqual({ repo: REPO, uninstalled: true });
  });

  it('keep the origin of the running copy when a staged update from another marketplace is cancelled', async () => {
    const f = fixture();
    const other = 'owner/other';
    // Every route of REPO, API and file hosts alike, served for `other` too.
    for (const [url, route] of [...f.gh.routes]) if (url.includes(`/${REPO}/`) || url.endsWith(`/${REPO}`)) f.gh.routes.set(url.replace(REPO, other), route);
    const m = f.make(null, [REPO, other]);
    await m.install(REPO, 'demo', { kind: 'release', version: '1.0.0' });
    applyStaged(join(f.profile, INSTALLED_PLUGINS_DIR), (id, err) => expect.fail(`${id}: ${String(err)}`));
    await m.install(other, 'demo', { kind: 'release', version: '1.0.0' });
    expect((await m.state()).history['demo']).toEqual({ repo: other, uninstalled: false });
    await m.cancel('demo');
    expect((await m.state()).history['demo']).toEqual({ repo: REPO, uninstalled: false });
    // A cancel with nothing staged changes nothing.
    await m.cancel('demo');
    expect((await m.state()).history['demo']).toEqual({ repo: REPO, uninstalled: false });
  });
});
