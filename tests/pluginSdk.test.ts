// Plugin SDK contracts (docs/plugin-architecture.md): placement, descriptor checks, declared adoption, channel audiences,
// network access and the core context's services.
import { ProviderRegistry } from '../src/core/ai/registry';
import { RuleKinds } from '../src/core/rules/kinds';
import { PluginInactiveError } from '@shared/pluginCall';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { defineChannels, definePlugin, definePreference } from '@plugin-sdk/shared';
import { defineCorePlugin, type DecisionProvider } from '@plugin-sdk/core';
import { testPlugin, type TestOptions, type TestPlugin } from '@plugin-sdk/core/testing';
import { placeByAnchor } from '@shared/anchors';
import { phoneGetsEvent, phoneMayCall } from '@shared/bundledPlugins';
import { type PluginDescriptor } from '@shared/bundledTypes';
import { checkBundled } from '@shared/bundledCheck';
import { adoptBundledData } from '../src/core/plugins/adoption';
import { partNotes } from '../src/core/attachmentNotes';
import type { CorePlugin } from '../src/core/plugins/context';
import { PluginHost } from '../src/core/plugins/host';
import { hostListed, ownerOrigins, pluginFetch } from '../src/core/plugins/net';
import { SETTINGS_KEYS } from '@shared/settings';
import { getSetting, setSetting, type Db } from '../src/core/db';
import { tempDb, tempDir } from './helpers';
// The build's plugins: fixture contracts, one listing calls and events for the phone.
vi.mock('virtual:bundled-plugins/shared', async () => ({ default: (await import('./lPhoneContracts')).PHONE_CONTRACTS, catalog: null }));

const manifest = (id: string) => ({ id, name: id, version: '1', description: '' });
const panel = (id: string, after: string) => ({ id, title: id, importance: 'reference' as const, dialog: false, iconPath: '', after });

/** `core` under the plugin testing harness, turned off after the test. */
function startHarness<D extends PluginDescriptor>(core: CorePlugin<D>, options?: TestOptions<D>): TestPlugin<D> {
  const t = testPlugin(core, options);
  onTestFinished(() => t.dispose());
  return t;
}

/** A client whose members a test calls whatever the contract says, to see the host refuse them. */
const untyped = (client: object): Record<string, (...args: unknown[]) => Promise<unknown>> => client as never;

describe('placement', () => {
  const anchors: Record<string, string> = { x1: 'b', x2: 'b', y: 'x1', gone: 'a', z: 'gone', w: 'nowhere' };
  it('puts items after their anchor in order, passes a missing anchor to its own, and ends with the unplaceable', () => {
    expect(placeByAnchor(['a', 'b', 'c'], ['x1', 'x2', 'y', 'z', 'w'], (t) => t, (id) => anchors[id])).toEqual(['a', 'z', 'b', 'x1', 'y', 'x2', 'c', 'w']);
  });
});

describe('checkBundled', () => {
  const plugin = (id: string, extra: Partial<PluginDescriptor> = {}): PluginDescriptor => ({ manifest: manifest(id), ...extra });
  it('accepts anchors on host items and on other plugins', () => {
    expect(() => checkBundled([plugin('one', { panels: [panel('p1', 'chat')] }), plugin('two', { panels: [panel('p2', 'p1')] })])).not.toThrow();
    expect(() => checkBundled([plugin('one', { settings: [{ id: 't', label: 't', tab: { after: 'archive', iconPath: '' } }] })])).not.toThrow();
  });
  it("accepts an anchor on a plugin that isn't here, as plugins installed separately need; a typo on one that is fails", () => {
    const menu = (after: string) => ({ slots: { messageMenu: [{ id: 'menu', after }] } });
    // Stamped: its owner says whether it's absent or a typo, whatever the mode.
    expect(() => checkBundled([plugin('one', menu('other.item'))])).not.toThrow();
    expect(() => checkBundled([plugin('one', menu('other.item')), plugin('other')])).toThrow(/follows other\.item, which no plugin provides/);
    expect(() => checkBundled([plugin('one', menu('one.missing'))])).toThrow(/which no plugin provides/);
    // Unknown unstamped items fail only when every possible declaring plugin is present.
    expect(() => checkBundled([plugin('one', { panels: [panel('p1', 'nope')] })], undefined, 'absent')).not.toThrow();
  });
  it('rejects an anchor nothing provides, a loop, and a section on a page that takes none', () => {
    expect(() => checkBundled([plugin('one', { panels: [panel('p1', 'nope')] })])).toThrow(/which no plugin provides/);
    expect(() => checkBundled([plugin('one', { panels: [panel('p1', 'p2'), panel('p2', 'p1')] })])).toThrow(/loops/);
    expect(() => checkBundled([plugin('one', { settings: [{ id: 's', label: 's', page: 'jev' as never }] })])).toThrow(/no host page/);
  });
  it('rejects a shortcut key the host or another plugin takes, and a Discord or malformed network host', () => {
    const key = (k: string, after = 'live') => ({ shortcuts: [{ key: k, hint: k, after }] });
    expect(() => checkBundled([plugin('one', key('a'))])).toThrow(/no host shortcut takes/);
    expect(() => checkBundled([plugin('one', key('L'))])).toThrow(/lowercase letter/);
    expect(() => checkBundled([plugin('one', key('q')), plugin('two', key('q'))])).toThrow(/Two bundled plugins provide shortcut q/);
    expect(() => checkBundled([plugin('one', key('q', 'nope'))])).toThrow(/which no plugin provides/);
    expect(() => checkBundled([plugin('one', key('q')), plugin('two', key('w', 'q'))])).not.toThrow();
    expect(() => checkBundled([plugin('one', { network: { hosts: ['cdn.discordapp.com'] } })])).toThrow(/embedded session/);
    expect(() => checkBundled([plugin('one', { network: { hosts: ['https://example.com'] } })])).toThrow(/lowercase hostname/);
    const settings = { settings: definePreference({ default: { url: '' }, normalize: () => ({ url: '' }) }) };
    expect(() => checkBundled([plugin('one', { preferences: settings, network: { ownerUrls: [{ setting: 'settings', field: 'url', fallback: 'http://127.0.0.1:1/' }] } })])).not.toThrow();
    expect(() => checkBundled([plugin('one', { preferences: settings, network: { ownerUrls: [{ setting: 'settings', field: 'url', fallback: 'not a url' }] } })])).toThrow(/valid fallback URL/);
  });

  it('rejects an adopted table name that is not a plain identifier', () => {
    expect(() => checkBundled([plugin('one', { adopts: { tables: { 'x; DROP TABLE rules': 'y' } } })])).toThrow(/names must match/);
  });
});

describe('declared adoption', () => {
  const adopter = definePlugin({
    manifest: manifest('adopter'),
    preferences: { key: definePreference({ default: null, normalize: (v: unknown) => v }) },
    adopts: { tables: { old_things: 'things' }, settings: { 'old.key': 'key' } },
  });
  const tables = (db: Db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('old_things', 'p_adopter_things')").pluck().all();

  it('renames the host table and setting into the namespace once', () => {
    const db = tempDb();
    db.exec('CREATE TABLE old_things (v TEXT)');
    db.prepare("INSERT INTO old_things VALUES ('kept')").run();
    setSetting(db, 'old.key', { a: 1 });
    adoptBundledData(db, [adopter]);
    adoptBundledData(db, [adopter]);
    expect(tables(db)).toEqual(['p_adopter_things']);
    expect(db.prepare('SELECT v FROM p_adopter_things').pluck().all()).toEqual(['kept']);
    expect(getSetting(db, 'plugin.adopter.key')).toEqual({ a: 1 });
    expect(getSetting(db, 'old.key')).toBeUndefined();
  });

  it('leaves both alone when the new name already exists', () => {
    const db = tempDb();
    db.exec('CREATE TABLE old_things (v TEXT); CREATE TABLE p_adopter_things (v TEXT)');
    setSetting(db, 'old.key', 1);
    setSetting(db, 'plugin.adopter.key', 2);
    adoptBundledData(db, [adopter]);
    expect(tables(db).sort()).toEqual(['old_things', 'p_adopter_things']);
    expect([getSetting(db, 'old.key'), getSetting(db, 'plugin.adopter.key')]).toEqual([1, 2]);
  });
});

describe('channels', () => {
  interface Core {
    ask(n: number): number;
    report(ok: boolean): void;
  }
  interface Events {
    shown: string;
    job: { id: string };
  }
  const probe = definePlugin({
    manifest: manifest('probe'),
    channels: defineChannels<{ core: Core; events: Events }>()({ core: { ask: ['renderer'], report: ['main'] }, events: { shown: ['renderer', 'phone'], job: ['main'] } }),
  });

  const start = (activate: Parameters<typeof defineCorePlugin<typeof probe>>[1]) => startHarness(defineCorePlugin(probe, activate), { archive: { channels: [{ id: 'c1' }] } });

  it('serves each member to the side its audiences name', async () => {
    const t = start((ctx) => ctx.channels.serve({ ask: (n) => n + 1, report: () => undefined }));
    await expect(t.client('renderer').ask(1)).resolves.toBe(2);
    await expect(untyped(t.client('phone')).ask!(1)).rejects.toThrow(/no function ask for phone/);
    await expect(untyped(t.client('renderer')).report!(true)).rejects.toThrow(/no function report/);
    await expect(t.client('main').report(true)).resolves.toBeUndefined();
    await expect(untyped(t.client('main')).ask!(1)).rejects.toThrow(/no function ask/);
  });

  it('fails the plugin when it serves less than it declares', () => {
    const t = start((ctx) => ctx.channels.serve({ ask: (n: number) => n } as never));
    expect(t.status()).toMatchObject({ status: 'error', error: expect.stringMatching(/declares core call report/) });
  });

  // Inactivity crosses the core service as its envelope: any other failure arrives as a plain Error with its message.
  it('returns inactivity for disabled bundled calls while preserving audience errors (completion reports: pluginCompletions.test.ts)', async () => {
    const report = vi.fn();
    const t = start((ctx) => ctx.channels.serve({ ask: (n) => n + 1, report }));
    await t.off();
    await expect(t.client('renderer').ask(1)).rejects.toBeInstanceOf(PluginInactiveError);
    await expect(t.client('main').report(true)).rejects.toBeInstanceOf(PluginInactiveError);
    expect(report).not.toHaveBeenCalled();
    await expect(untyped(t.client('phone')).ask!(1)).rejects.toThrow('has no function ask for phone');
    await expect(untyped(t.client('renderer')).missing!()).rejects.toThrow('has no function missing');
  });

  it('carries ordinary disabled main calls as inactive results through the core service', async () => {
    const t = start((ctx) => ctx.channels.serve({ ask: (n) => n, report: () => undefined }));
    await t.off();
    await expect(t.client('main').report(false)).rejects.toBeInstanceOf(PluginInactiveError);
  });

  it("emits a plugin's events for main to fan out; nothing once it is off", async () => {
    const t = start((ctx) => {
      ctx.channels.emit('shown', 'hi');
      ctx.archive.onChanged(() => ctx.channels.emit('job', { id: 'late' }));
    });
    await t.off();
    t.archive.arrive([{ channelId: 'c1', content: 'after' }]);
    expect([t.events('shown'), t.events('job')]).toEqual([['hi'], []]);
  });

  it("gives the phone only what a plugin's contract lists for it", () => {
    expect([phoneMayCall('voice', 'status'), phoneMayCall('voice', 'install'), phoneMayCall('voice', 'audioFetched')]).toEqual([true, false, false]);
    expect([phoneGetsEvent('voice', 'status'), phoneGetsEvent('voice', 'fetchAudio')]).toEqual([true, false]);
  });
});

describe('network access', () => {
  afterEach(() => vi.unstubAllGlobals());
  /** The global fetch plugins must not call, answering from `routes` (a 404 otherwise). */
  const serve = (routes: Record<string, () => Response>) => {
    const sent = vi.fn(async (u: URL) => routes[u.href]?.() ?? new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', sent);
    return sent;
  };
  const moved = (location: string) => () => new Response(null, { status: 302, headers: { location } });
  const noOwnerUrls = async (): Promise<string[]> => [];

  it('covers a listed host and its subdomains, nothing that merely ends the same', () => {
    expect([hostListed(['hf.co'], 'hf.co'), hostListed(['hf.co'], 'us.aws.cdn.hf.co'), hostListed(['hf.co'], 'evilhf.co')]).toEqual([true, true, false]);
  });

  it('refuses plain http and unlisted hosts before sending anything', async () => {
    const sent = serve({});
    const get = pluginFetch('p', ['example.com'], noOwnerUrls);
    await expect(get('http://example.com/a')).rejects.toThrow(/not a declared network host/);
    await expect(get('https://example.org/a')).rejects.toThrow(/not a declared network host/);
    expect(sent).not.toHaveBeenCalled();
  });

  it('follows redirects within the listed hosts and refuses a hop outside them unsent', async () => {
    const sent = serve({
      'https://example.com/a': moved('https://cdn.example.com/b'),
      'https://cdn.example.com/b': () => new Response('ok'),
      'https://example.com/out': moved('https://discord.com/api'),
    });
    const get = pluginFetch('p', ['example.com'], noOwnerUrls);
    await expect((await get('https://example.com/a')).text()).resolves.toBe('ok');
    await expect(get('https://example.com/out')).rejects.toThrow(/https:\/\/discord.com: not a declared network host/);
    expect(sent.mock.calls.map(([u]) => u.hostname)).toEqual(['example.com', 'cdn.example.com', 'example.com']);
  });

  it('drops credentials on a redirect to another origin, as native fetch does, and keeps them on the same origin', async () => {
    const auth: (string | null)[] = [];
    const sent = vi.fn(async (u: URL, init: RequestInit) => {
      const h = new Headers(init.headers);
      auth.push([h.get('authorization'), h.get('cookie'), h.get('proxy-authorization')].join('|'));
      if (u.href === 'https://example.com/a') return new Response(null, { status: 307, headers: { location: '/b' } });
      if (u.href === 'https://example.com/b') return new Response(null, { status: 307, headers: { location: 'https://cdn.example.com/c' } });
      return new Response('ok');
    });
    vi.stubGlobal('fetch', sent);
    const get = pluginFetch('p', ['example.com'], noOwnerUrls);
    await get('https://example.com/a', { method: 'POST', body: '{}', headers: { authorization: 'Bearer sk', cookie: 'c=1', 'proxy-authorization': 'p' } });
    expect(auth).toEqual(['Bearer sk|c=1|p', 'Bearer sk|c=1|p', '||']);
  });

  it('treats a trailing-dot hostname as the same host: Discord stays unreachable, listed hosts still match', async () => {
    const sent = serve({ 'https://example.com./a': () => new Response('ok') });
    const stored = { settings: { url: 'https://discord.com.' } };
    const get = pluginFetch('p', ['example.com'], ownerOrigins([{ setting: 'settings', field: 'url', fallback: 'http://127.0.0.1:11434' }], (n) => stored[n as 'settings']));
    await expect(get('https://discord.com./api')).rejects.toThrow(/may not fetch/);
    await expect(get('https://cdn.discordapp.com./x')).rejects.toThrow(/may not fetch/);
    await expect((await get('https://example.com./a')).text()).resolves.toBe('ok');
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("reaches an owner-set address's origin, over http too, as saved at each request; never Discord", async () => {
    const sent = serve({ 'http://10.0.0.5:11434/api/tags': () => new Response('ok'), 'http://127.0.0.1:11434/api/tags': () => new Response('ok') });
    const stored: Record<string, unknown> = {};
    const urls = [{ setting: 'settings', field: 'url', fallback: 'http://127.0.0.1:11434' }];
    const get = pluginFetch('p', [], ownerOrigins(urls, (name) => stored[name]));
    await expect((await get('http://127.0.0.1:11434/api/tags')).text()).resolves.toBe('ok');
    stored['settings'] = { url: 'http://10.0.0.5:11434/' };
    await expect((await get('http://10.0.0.5:11434/api/tags')).text()).resolves.toBe('ok');
    await expect(get('http://127.0.0.1:11434/api/tags')).rejects.toThrow(/not a declared network host or an address set for it/);
    await expect(get('http://10.0.0.5:8080/')).rejects.toThrow(/may not fetch/);
    stored['settings'] = { url: 'https://discord.com' };
    await expect(get('https://discord.com/api')).rejects.toThrow(/may not fetch/);
    expect(sent).toHaveBeenCalledTimes(2);
  });
});

/** A plugin host over a fresh archive running `core`, as core init starts bundled plugins. */
function startHost(core: CorePlugin) {
  const db = tempDb();
  const host = new PluginHost(
    tempDir(),
    {
      db,
      emit: () => undefined,
      changed: () => undefined,
      ai: async () => ({ text: '' }),
      decider: () => null,
      bundled: {
        rules: new RuleKinds(),
        ready: () => db,
        archive: () => null as never,
        mediaDir: tempDir(),
        attachmentsDir: tempDir(),
        pluginData: { root: tempDir(), unmoved: {} },
        storeText: () => undefined,
        catchUp: () => undefined,
        storeLinkText: () => undefined, storeLinkImages: () => undefined,
        saveSetting: (key, value) => setSetting(db, key, value),
        aiSettings: () => null as never,
        providers: new ProviderRegistry(() => undefined),
        decider: () => null,
        now: Date.now,
      },
    },
    [core],
  );
  host.startBundled();
  return { host };
}

describe('context services', () => {
  const judge = definePlugin({ manifest: manifest('judge'), jev: { features: [{ key: 'linkWorth', default: false }] } });
  const jev = { model: 'm', maxInputChars: 1, decide: () => Promise.reject(new Error('not asked')) } satisfies DecisionProvider;

  it('gives Jev only for the switches a plugin declares, stamped with its id', () => {
    let asked: unknown;
    const t = startHarness(
      defineCorePlugin(judge, (ctx) => {
        asked = ctx.jev.decider('linkWorth');
        ctx.jev.decider('linkSafety' as never);
      }),
      { ai: { jev, switches: { linkWorth: true } } },
    );
    // Handed out bound to the activation's lifetime, so a wrapper of the same Jev.
    expect(asked).toMatchObject({ model: 'm' });
    expect(t.status()).toMatchObject({ status: 'error', error: expect.stringMatching(/names Jev switch linkSafety but declares none/) });
  });

  it("leaves out a notes provider that throws, recording it on the plugin, without failing the page's other notes", () => {
    const noter = definePlugin({ manifest: manifest('noter') });
    const t = startHarness(
      defineCorePlugin(noter, (ctx) =>
        ctx.archive.attachmentNotes.provide(() => {
          throw new Error('broken notes');
        }),
      ),
    );
    expect(partNotes([{ id: 'm1', attachmentIds: ['a1'] }]).size).toBe(0);
    expect(t.status()).toMatchObject({ error: expect.stringMatching(/broken notes/) });
  });

  // Link index rebuilds and settings saves are host events the harness has no trigger for: this drives the host itself.
  it('reports archive changes, link index rebuilds and AI settings saves while the plugin is on', async () => {
    const heard: unknown[] = [];
    const { host } = startHost(
      defineCorePlugin(judge, (ctx) => {
        ctx.archive.onChanged((ids) => heard.push(ids));
        ctx.archive.linkIndex.onRebuilt(() => heard.push('rebuilt'));
        ctx.ai.onSettingsChange(() => heard.push('ai'));
      }),
    );
    host.archiveChanged(['c1']);
    host.linksRebuilt();
    host.settingChanged(SETTINGS_KEYS.ai);
    host.settingChanged('other');
    await host.setEnabled('judge', false);
    host.archiveChanged(['c2']);
    expect(heard).toEqual([['c1'], 'rebuilt', 'ai']);
  });
});
