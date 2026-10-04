// Settings → Plugins → Marketplaces' store: reloads after every action, per-action errors, pending changes, and what
// each listed plugin offers against the host's plugin SDK.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_SDK_VERSION } from '../src/shared/installedPlugins';
import type { InstallChoice, InstalledEntry, MarketplaceApi, MarketplaceListing, MarketplacePlugin, MarketplaceRelease } from '../src/shared/marketplace';

type State = Awaited<ReturnType<MarketplaceApi['state']>>;

const env = vi.hoisted(() => ({
  handlers: new Map<string, () => void>(),
  state: { marketplaces: [], installed: [], history: {} } as State,
  stateCalls: 0,
  /** When set, the next call of that method rejects with it. */
  failNext: new Map<string, Error>(),
  /** When set, state() waits for the test to answer. */
  heldStates: null as ((s: State) => void)[] | null,
}));

const [HOST_MAJOR, HOST_MINOR] = PLUGIN_SDK_VERSION.split('.').map(Number) as [number, number];
const OLDER_SDK = PLUGIN_SDK_VERSION;
const NEWER_MINOR_SDK = `${HOST_MAJOR}.${HOST_MINOR + 1}.0`;
const OTHER_MAJOR_SDK = `${HOST_MAJOR + 1}.0.0`;
const REPO = 'owner/market';
const INSTALLED_AT = 1;

const release = (version: string, sdk: string): MarketplaceRelease => ({ version, tag: `demo-v${version}`, asset: 'demo.tar.gz', sha256: '0'.repeat(64), sdk });
const plugin = (releases: MarketplaceRelease[], source?: MarketplacePlugin['source']): MarketplacePlugin => ({ id: 'demo', name: 'Demo', description: '', releases, ...(source ? { source } : {}) });
const listing = (repo: string, plugins: MarketplacePlugin[] = []): MarketplaceListing => ({ repo, hasToken: false, builtIn: false, plugins, error: null, fetchedAt: null });
const releaseSource = (version: string, repo = REPO) => ({ kind: 'release' as const, repo, tag: `demo-v${version}`, sha256: '0'.repeat(64), installedAt: INSTALLED_AT });
const installed = (version: string, pending: InstalledEntry['pending'] = null, repo = REPO): InstalledEntry => ({ id: 'demo', name: 'Demo', version, source: releaseSource(version, repo), pending });

/** A fake of main's marketplace: mutates `env.state`, and fails a method once when asked. */
const method = <A extends unknown[]>(name: string, change: (...args: A) => void) => async (...args: A): Promise<void> => {
  const err = env.failNext.get(name);
  env.failNext.delete(name);
  if (err) throw err;
  change(...args);
};
const fake: MarketplaceApi = {
  state: () => {
    env.stateCalls++;
    const snapshot = structuredClone(env.state);
    return env.heldStates ? new Promise((resolve) => env.heldStates!.push(resolve)) : Promise.resolve(snapshot);
  },
  add: method('add', (repo: string, token: string | null) => void env.state.marketplaces.push({ ...listing(repo), hasToken: token !== null })),
  remove: method('remove', (repo: string) => void (env.state.marketplaces = env.state.marketplaces.filter((m) => m.repo !== repo))),
  setToken: method('setToken', () => undefined),
  refresh: method('refresh', () => undefined),
  install: method('install', (repo: string, id: string, choice: InstallChoice) => {
    const version = choice.kind === 'release' ? choice.version : '0.0.0';
    env.state.installed = [...env.state.installed.filter((e) => e.id !== id), { id, name: id, version: null, source: null, pending: { kind: 'install', version, source: releaseSource(version, repo) } }];
  }),
  installLocal: method('installLocal', () => undefined),
  uninstall: method('uninstall', (id: string) => {
    env.state.installed = env.state.installed.flatMap((e) => (e.id !== id ? [e] : e.version ? [{ ...e, pending: { kind: 'remove' as const } }] : []));
  }),
  cancel: method('cancel', (id: string) => {
    env.state.installed = env.state.installed.flatMap((e) => (e.id !== id ? [e] : e.version ? [{ ...e, pending: null }] : []));
  }),
};
const restartApp = method('restart', () => undefined);
vi.mock('@/api', () => ({ api: { marketplace: fake, restartApp } }));
vi.mock('../src/renderer/src/state/events', () => ({ onAppEvent: (type: string, fn: () => void) => void env.handlers.set(type, fn) }));

// A renderer module: imported by path so the node type-check doesn't follow it.
const storePath = '../src/renderer/src/state/marketplace';
interface ReleaseOffer { release: MarketplaceRelease | null; action: string | null; incompatible: string | null }
const store = (await import(storePath)) as {
  marketplaceState(): State | null;
  loadMarketplaces(): Promise<void>;
  actionKey: { add: string; restart: string; marketplace(repo: string): string; plugin(id: string): string };
  actionBusy(key: string): boolean;
  actionError(key: string): string | null;
  addMarketplace(repo: string, token: string | null): Promise<boolean>;
  installPlugin(repo: string, id: string, choice: InstallChoice): Promise<boolean>;
  uninstallPlugin(id: string): Promise<boolean>;
  cancelPending(id: string): Promise<boolean>;
  restartApp(): Promise<boolean>;
  pendingChanges(): InstalledEntry[];
  installedEntry(id: string): InstalledEntry | undefined;
  unlistedInstalled(): InstalledEntry[];
  pendingText(entry: InstalledEntry | undefined): string | null;
  changeStatus(entry: InstalledEntry | undefined): { label: string; tint: string | null } | null;
  versionsText(entry: InstalledEntry | undefined, listedIn?: string): string | null;
  cancelText(entry: InstalledEntry): string | null;
  removable(entry: InstalledEntry): boolean;
  releaseOffer(repo: string, plugin: MarketplacePlugin, entry: InstalledEntry | undefined): ReleaseOffer;
};
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));

beforeEach(() => {
  env.state = { marketplaces: [], installed: [], history: {} };
  env.failNext.clear();
  env.heldStates = null;
});

describe('marketplace store', () => {
  it('ignores plugins-changed until the view has loaded once, then reloads on it', async () => {
    env.handlers.get('plugins-changed')!();
    expect(env.stateCalls).toBe(0);
    await store.loadMarketplaces();
    env.state.marketplaces.push(listing(REPO));
    env.handlers.get('plugins-changed')!();
    await settle();
    expect(store.marketplaceState()?.marketplaces.map((m) => m.repo)).toEqual([REPO]);
  });

  it('reloads after a change, and keeps a failure in its own slot', async () => {
    await store.loadMarketplaces();
    expect(await store.addMarketplace(REPO, 'token')).toBe(true);
    expect(store.marketplaceState()?.marketplaces).toEqual([{ ...listing(REPO), hasToken: true }]);

    env.failNext.set('add', new Error('marketplace.json: format 2 is not 1'));
    expect(await store.addMarketplace('owner/other', null)).toBe(false);
    expect(store.actionError(store.actionKey.add)).toContain('format 2');
    expect(store.actionBusy(store.actionKey.add)).toBe(false);
    expect(store.actionError(store.actionKey.marketplace(REPO))).toBeNull();

    expect(await store.addMarketplace('owner/other', null)).toBe(true);
    expect(store.actionError(store.actionKey.add)).toBeNull();
  });

  it('shows staged installs as pending until cancelled, and restart errors in their slot', async () => {
    env.state.marketplaces.push(listing(REPO, [plugin([release('1.0.0', OLDER_SDK)])]));
    await store.loadMarketplaces();
    expect(store.pendingChanges()).toEqual([]);

    await store.installPlugin(REPO, 'demo', { kind: 'release', version: '1.0.0' });
    expect(store.pendingChanges().map((e) => e.id)).toEqual(['demo']);
    expect(store.pendingText(store.installedEntry('demo'))).toBe('demo 1.0.0 installs');
    expect(store.changeStatus(store.installedEntry('demo'))?.label).toBe('Pending install');
    expect(store.versionsText(store.installedEntry('demo'), REPO)).toBe('Next start: 1.0.0 (release demo-v1.0.0)');

    env.failNext.set('restart', new Error('busy'));
    await store.restartApp();
    expect(store.actionError(store.actionKey.restart)).toBe('busy');

    expect(store.cancelText(store.installedEntry('demo')!)).toBe('Cancel install');
    expect(store.removable(store.installedEntry('demo')!)).toBe(false);
    await store.cancelPending('demo');
    expect(store.pendingChanges()).toEqual([]);
  });

  it('stages a removal of a running plugin, and cancels it back to running', async () => {
    env.state.installed.push(installed('1.0.0'));
    await store.loadMarketplaces();
    expect(store.removable(store.installedEntry('demo')!)).toBe(true);
    expect(store.cancelText(store.installedEntry('demo')!)).toBeNull();
    expect(store.changeStatus(store.installedEntry('demo'))).toEqual({ label: 'Installed', tint: 'neutral' });

    await store.uninstallPlugin('demo');
    expect(store.pendingText(store.installedEntry('demo'))).toBe('Demo is uninstalled');
    expect(store.changeStatus(store.installedEntry('demo'))).toEqual({ label: 'Pending uninstall', tint: 'danger' });
    expect(store.cancelText(store.installedEntry('demo')!)).toBe('Cancel uninstall');
    expect(store.removable(store.installedEntry('demo')!)).toBe(false);

    await store.cancelPending('demo');
    expect(store.installedEntry('demo')).toEqual(installed('1.0.0'));
  });

  it('words an update as running → next, naming a repo other than the one listing it', () => {
    const update = installed('1.0.0', { kind: 'install', version: '1.1.0', source: releaseSource('1.1.0') });
    expect(store.versionsText(update, REPO)).toBe('Running 1.0.0 (release demo-v1.0.0) → 1.1.0 (release demo-v1.1.0)');
    expect(store.changeStatus(update)).toEqual({ label: 'Pending update', tint: null });
    expect(store.pendingText(update)).toBe('Demo updates to 1.1.0');
    expect(store.versionsText(installed('1.0.0', null, 'owner/elsewhere'), REPO)).toBe('Running 1.0.0 (release demo-v1.0.0) from owner/elsewhere');
    expect(store.versionsText(undefined)).toBeNull();
  });

  it('never lets an earlier load overwrite a later one', async () => {
    env.heldStates = [];
    const first = store.loadMarketplaces();
    const second = store.loadMarketplaces();
    const [answerFirst, answerSecond] = env.heldStates;
    answerSecond!({ marketplaces: [listing('owner/new')], installed: [], history: {} });
    answerFirst!({ marketplaces: [listing('owner/old')], installed: [], history: {} });
    await Promise.all([first, second]);
    expect(store.marketplaceState()?.marketplaces.map((m) => m.repo)).toEqual(['owner/new']);
  });

  it('lists installed plugins no added marketplace lists', async () => {
    env.state.marketplaces.push(listing(REPO, [plugin([])]));
    env.state.installed.push(installed('1.0.0'), { ...installed('2.0.0'), id: 'local-one' });
    await store.loadMarketplaces();
    expect(store.unlistedInstalled().map((e) => e.id)).toEqual(['local-one']);
  });
});

describe('release offer', () => {
  it('installs the newest release this ChattyPop can run, saying why a newer one cannot', () => {
    const offer = store.releaseOffer(REPO, plugin([release('2.0.0', NEWER_MINOR_SDK), release('1.0.0', OLDER_SDK)]), undefined);
    expect(offer.release?.version).toBe('1.0.0');
    expect(offer.action).toBe('Install 1.0.0');
    expect(offer.incompatible).toContain('Update ChattyPop');
  });

  it('offers nothing when no release can run here', () => {
    const offer = store.releaseOffer(REPO, plugin([release('2.0.0', OTHER_MAJOR_SDK)]), undefined);
    expect(offer).toMatchObject({ release: null, action: null });
    expect(offer.incompatible).toContain(`Rebuild it for SDK ${HOST_MAJOR}`);
    expect(store.releaseOffer(REPO, plugin([]), undefined)).toEqual({ release: null, action: null, incompatible: null });
  });

  it('updates an older install, and is up to date on the same release from the same marketplace', () => {
    const p = plugin([release('1.1.0', OLDER_SDK)]);
    expect(store.releaseOffer(REPO, p, installed('1.0.0')).action).toBe('Update to 1.1.0');
    expect(store.releaseOffer(REPO, p, installed('1.1.0')).action).toBeNull();
    expect(store.releaseOffer(REPO, p, installed('1.1.0', null, 'owner/elsewhere')).action).toBe('Switch to release 1.1.0');
  });

  it('switches from a version it cannot order (not x.y.z) or a running build with no source, never offering an install', () => {
    const p = plugin([release('1.1.0', OLDER_SDK)]);
    const local = (version: string): InstalledEntry => ({ ...installed(version), source: { kind: 'local', path: 'C:/build', installedAt: INSTALLED_AT } });
    expect(store.releaseOffer(REPO, p, local('1.1.0-beta')).action).toBe('Switch to release 1.1.0');
    expect(store.releaseOffer(REPO, p, local('2.0.0-beta')).action).toBe('Switch to release 1.1.0');
    expect(store.releaseOffer(REPO, p, local('1.0.0')).action).toBe('Update to 1.1.0');
    expect(store.releaseOffer(REPO, p, { ...installed('1.1.0'), source: null }).action).toBe('Switch to release 1.1.0');
    expect(store.releaseOffer(REPO, p, { ...installed('1.0.0'), source: null }).action).toBe('Update to 1.1.0');
  });

  it('judges against a staged install, and against the running version while its removal is staged', () => {
    const p = plugin([release('1.1.0', OLDER_SDK)]);
    expect(store.releaseOffer(REPO, p, installed('1.0.0', { kind: 'install', version: '1.1.0', source: releaseSource('1.1.0') })).action).toBeNull();
    // Cancel uninstall keeps the running release; no install of the same one is offered beside it.
    expect(store.releaseOffer(REPO, p, installed('1.1.0', { kind: 'remove' })).action).toBeNull();
    expect(store.releaseOffer(REPO, p, installed('1.0.0', { kind: 'remove' })).action).toBe('Update to 1.1.0');
    expect(store.releaseOffer(REPO, p, installed('1.1.0', { kind: 'remove' }, 'owner/elsewhere')).action).toBe('Switch to release 1.1.0');
  });
});
