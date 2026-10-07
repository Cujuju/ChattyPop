// Phone points in main (docs/plugin-architecture.md §3): the transport, routes, gateway stamping and the main-side
// lifecycle, network and secrets a transport plugin uses, exercised through probe plugins.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { defineChannels, definePlugin } from '@plugin-sdk/shared';
import { type PluginDescriptor } from '@shared/bundledTypes';
import { checkBundled } from '@shared/bundledCheck';
import { DEFAULT_PHONE_LOOK, PHONE_LOOK_KEYS, normalizePhoneLook, phoneLookEvent, phoneLookSetting } from '@shared/phoneLook';
import type { AppEvent } from '@shared/contract';
import type { DeliveredNotification } from '@shared/notifications';
import { tempDir } from './helpers';

const env = vi.hoisted(() => ({ userData: '' }));
// The build's plugins: fixture contracts stating what the phone may read, call and hear.
vi.mock('virtual:bundled-plugins/shared', async () => ({ default: (await import('./lPhoneContracts')).PHONE_CONTRACTS, catalog: null }));
vi.mock('electron', () => ({
  app: { getPath: () => env.userData },
  dialog: {},
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(`enc:${s}`), decryptString: (b: Buffer) => b.toString().slice('enc:'.length) },
}));

const { PhoneCallRefused, PhoneHub, PhoneRouteMissing } = await import('../src/main/phone/hub');
const { createMainContext } = await import('../src/main/plugins/context');
const { whileActive } = await import('../src/main/plugins/states');
const { readSecret, SECRET_FILES } = await import('../src/main/secretFile');
const { PHONE_HOST_SETTINGS, PHONE_WRITABLE_SETTINGS } = await import('../src/shared/phone');
const { SETTINGS_KEYS } = await import('../src/shared/settings');
const { rendererPages } = await import('../src/main/plugins/pages');

const manifest = (id: string) => ({ id, name: id, version: '1', description: '' });
const probe = definePlugin({
  manifest: manifest('probe'),
  network: { hosts: ['push.example.com'], loopback: true },
  phone: { transport: true, routes: ['echo'] },
  channels: defineChannels<{ events: { shown: number; quiet: number } }>()({ events: { shown: ['renderer', 'phone'], quiet: ['main'] } }),
});
const plain = definePlugin({ manifest: manifest('plain') });

interface Harness {
  hub: InstanceType<typeof PhoneHub>;
  core: { call: ReturnType<typeof vi.fn> };
  discord: { send: ReturnType<typeof vi.fn> };
  on: Set<string>;
  published: AppEvent[];
}

function harness(): Harness {
  const on = new Set(['probe', 'plain']);
  const core = { call: vi.fn(async (method: string, ...params: unknown[]) => ({ method, params })) };
  const discord = { send: vi.fn(async () => 'sent') };
  const hub = new PhoneHub({ core: core as never, discord: () => discord as never, media: async (url) => new Response(url.href), active: (id) => on.has(id) });
  return { hub, core, discord, on, published: [] };
}

const contextFor = <D extends PluginDescriptor>(plugin: D, h: Harness) =>
  createMainContext(plugin, {
    core: h.core,
    phone: h.hub,
    states: { active: (id: string) => h.on.has(id) },
    publish: (e: AppEvent) => void h.published.push(e),
    pages: rendererPages(tempDir(), null),
    secrets: SECRET_FILES,
    diag: () => undefined,
  } as never, { serve: () => undefined, on: () => undefined, whileActive: () => undefined, stage: (apply: () => void) => apply() });

const notice: DeliveredNotification = { title: 't', body: 'b', target: null, kind: 'plugin' };

describe('phone settings', () => {
  /** Stored settings as the desktop keeps them, including parts only the desktop may read. */
  const STORED: Record<string, unknown> = {
    appearance: { theme: 'tide' },
    privacyMode: true,
    savedSearches: ['from:ann'],
    discordSidebar: { serversHidden: true, channelsCollapsed: false },
    'archive.density': 'compact',
    archive: { backfillDays: 7, reverifyChannelIds: ['c1'], attachmentCapGb: 5 },
    ai: { defaultProvider: 'claude', providers: { claude: { enabled: true } }, jev: { catchUpBadges: true }, ollamaUrl: 'http://pc:11434', jevConnection: 'typesafe' },
    'layout.preset': 'reading',
    'layout.custom': { mine: { name: 'Mine' } },
    'layout.collapsedPanels': ['stats'],
    'layout.sidebarCollapsed': true,
    'layout.sizes': { a: 1 },
    'layout.windows': { a: { x: 1 } },
    notifications: { desktop: false },
    jevQueries: { q: 'owner edit' },
    'plugin.inbox.sort': 'rule',
    'plugin.inbox.ruleIds': [1],
    'plugin.commands.commands': { ask: { enabled: true, prefix: 'ask', prompt: 'DESKTOP-ONLY' }, query: { enabled: false, prefix: 'q', provider: 'claude' } },
    'plugin.digest.lastRunAt': 5,
    'plugin.voice.settings': { model: 'DESKTOP-ONLY' },
    'plugin.digest.settings': { defaultRange: '24h', focus: 'DESKTOP-ONLY', prompts: { digest: 'DESKTOP-ONLY' } },
    'plugin.digest.seenId': 3,
    'plugin.gone.settings': { model: 'DESKTOP-ONLY' },
    'plugin.gone.config': { enabled: true },
  };
  /** What the phone's stores read of each, and nothing of the rest. */
  const PHONE_SEES: Record<string, unknown> = {
    appearance: { theme: 'tide' },
    privacyMode: true,
    savedSearches: ['from:ann'],
    discordSidebar: { serversHidden: true, channelsCollapsed: false },
    'archive.density': 'compact',
    archive: { backfillDays: 7 },
    ai: { providers: { claude: { enabled: true } }, jev: { catchUpBadges: true } },
    'layout.preset': 'reading',
    'layout.custom': { mine: { name: 'Mine' } },
    'layout.collapsedPanels': ['stats'],
    'layout.sidebarCollapsed': true,
    'plugin.inbox.sort': 'rule',
    'plugin.inbox.ruleIds': [1],
    'plugin.commands.commands': { ask: { enabled: true, prefix: 'ask' }, query: { enabled: false, prefix: 'q' } },
    'plugin.digest.settings': { defaultRange: '24h' },
    'plugin.digest.seenId': 3,
  };

  it('reads only the settings the phone uses, and only the parts it uses, on calls and change events alike', async () => {
    const core = { call: vi.fn(async (method: string, key: unknown) => (method === 'getSetting' ? STORED[key as string] : null)) };
    const hub = new PhoneHub({ core: core as never, discord: () => ({}) as never, media: async () => new Response(), active: () => true });
    const events: AppEvent[] = [];
    const { gateway } = hub.connect('probe', { broadcast: (e) => void events.push(e), notify: () => undefined });
    for (const [key, value] of Object.entries(STORED)) {
      expect(await gateway.call('core', 'getSetting', [key]), key).toEqual(PHONE_SEES[key]);
      hub.broadcast({ type: 'setting-changed', key, value });
    }
    expect(events).toEqual(Object.entries(PHONE_SEES).map(([key, value]) => ({ type: 'setting-changed', key, value })));
  });

  it('writes only the settings the phone may write, stored through their normalizers', async () => {
    const core = { call: vi.fn(async () => undefined) };
    const hub = new PhoneHub({ core: core as never, discord: () => ({}) as never, media: async () => new Response(), active: () => true });
    const { gateway } = hub.connect('probe', { broadcast: () => undefined, notify: () => undefined });
    await gateway.call('core', 'setSetting', [SETTINGS_KEYS.countedBots, ['b1', 'b1', '', 7, 'b2']]);
    expect(core.call).toHaveBeenLastCalledWith('setSetting', SETTINGS_KEYS.countedBots, ['b1', 'b2']);
    for (const key of [SETTINGS_KEYS.privacyMode, SETTINGS_KEYS.appearance, 'plugin.digest.settings']) {
      await expect(gateway.call('core', 'setSetting', [key, true]), key).rejects.toBeInstanceOf(PhoneCallRefused);
    }
    expect(core.call).toHaveBeenCalledTimes(1);
  });

  it('a setting the phone may write, it reads whole: its write never overwrites parts it cannot see', () => {
    for (const key of Object.keys(PHONE_WRITABLE_SETTINGS)) expect(PHONE_HOST_SETTINGS[key], key).toBe(true);
  });

  it("a phone's own look stands in for the desktop's theme and density, and only where it chose", () => {
    const own = normalizePhoneLook({ theme: 'paper', density: 'cozy', textSize: 'large' });
    const follows = normalizePhoneLook({ theme: 'bogus', textSize: 'huge' });
    expect(follows).toEqual(DEFAULT_PHONE_LOOK);
    for (const key of PHONE_LOOK_KEYS) expect(phoneLookSetting(key, PHONE_SEES[key], follows), key).toEqual(PHONE_SEES[key]);
    expect(phoneLookSetting('appearance', PHONE_SEES['appearance'], own)).toEqual({ theme: 'paper' });
    expect(phoneLookSetting('appearance', undefined, own)).toEqual({ theme: 'paper' });
    expect(phoneLookSetting('archive.density', 'compact', own)).toBe('cozy');
    expect(phoneLookSetting('privacyMode', true, own)).toBe(true);
    expect(phoneLookEvent({ type: 'setting-changed', key: 'archive.density', value: 'compact' }, own)).toEqual({ type: 'setting-changed', key: 'archive.density', value: 'cozy' });
    const other: AppEvent = { type: 'rules-changed' };
    expect(phoneLookEvent(other, own)).toBe(other);
    const desktop: AppEvent = { type: 'setting-changed', key: 'archive.density', value: 'compact' };
    expect(phoneLookEvent(desktop, follows)).toBe(desktop);
  });
});

describe('phone transport', () => {
  it('drops phone traffic while no transport is connected, then hands it only the phone’s events', () => {
    const h = harness();
    h.hub.broadcast({ type: 'rules-changed' });
    h.hub.notify(notice);
    const events: AppEvent[] = [];
    const notified: DeliveredNotification[] = [];
    const link = contextFor(probe, h).phone.connect({ broadcast: (e) => events.push(e), notify: (n) => notified.push(n) });
    h.hub.broadcast({ type: 'rules-changed' });
    h.hub.broadcast({ type: 'open-message', channelId: 'c1' });
    h.hub.notify(notice);
    expect(events).toEqual([{ type: 'rules-changed' }]);
    expect(notified).toEqual([notice]);
    link.disconnect();
    h.hub.broadcast({ type: 'rules-changed' });
    expect(events).toHaveLength(1);
  });

  it('lets one declared transport connect at a time', () => {
    const h = harness();
    const sink = { broadcast: () => undefined, notify: () => undefined };
    expect(() => contextFor(plain, h).phone.connect(sink)).toThrow(/does not declare phone.transport/);
    const first = contextFor(probe, h).phone.connect(sink);
    expect(() => h.hub.connect('other', sink)).toThrow(/probe already carries the phone/);
    first.disconnect();
    first.disconnect();
    expect(() => h.hub.connect('other', sink).disconnect()).not.toThrow();
  });

  it('builds with at most one transport and well-formed route names', () => {
    const d = (id: string, phone: PluginDescriptor['phone']): PluginDescriptor => ({ manifest: manifest(id), phone });
    expect(() => checkBundled([d('one', { transport: true }), d('two', { routes: ['x'] })])).not.toThrow();
    expect(() => checkBundled([d('one', { transport: true }), d('two', { transport: true })])).toThrow(/phone transport/);
    expect(() => checkBundled([d('one', { routes: ['Bad/Name'] })])).toThrow(/phone route/);
  });
});

describe('phone gateway', () => {
  it('stamps calls as the phone’s and refuses what the phone may not reach', async () => {
    const h = harness();
    const { gateway } = contextFor(probe, h).phone.connect({ broadcast: () => undefined, notify: () => undefined });
    await gateway.call('core', 'directory', []);
    expect(h.core.call).toHaveBeenLastCalledWith('directory');
    await gateway.call('plugins', 'callCore', ['tags', 'list', [1]]);
    expect(h.core.call).toHaveBeenLastCalledWith('pluginCall', 'phone', 'tags', 'list', [1]);
    await expect(gateway.call('discord', 'send', [{ text: 'hi' }])).resolves.toBe('sent');
    for (const [group, method, params] of [['core', 'setSetting', []], ['core', 'pluginCall', ['main', 'x', 'y', []]], ['discord', 'probe', []], ['plugins', 'callMain', ['x', 'y', []]], ['plugins', 'callCore', [{}, 'y', []]]] as const) {
      await expect(gateway.call(group, method, [...params])).rejects.toBeInstanceOf(PhoneCallRefused);
    }
    expect(await (await gateway.media(new URL('cp-media://avatar/1'), null)).text()).toBe('cp-media://avatar/1');
  });

  it('answers a declared route while its owner is on, the inactive envelope while off, and refuses unknown routes', async () => {
    const h = harness();
    const ctx = contextFor(probe, h);
    ctx.phone.route('echo', (r) => ({ got: r.body, device: r.device }));
    expect(() => ctx.phone.route('other' as never, () => null)).toThrow(/does not declare phone route other/);
    const { gateway } = ctx.phone.connect({ broadcast: () => undefined, notify: () => undefined });
    const request = { method: 'POST', query: {}, body: { n: 1 }, device: 'd1' };
    await expect(gateway.route('probe', 'echo', request)).resolves.toEqual({ status: 'ok', value: { got: { n: 1 }, device: 'd1' } });
    h.on.delete('probe');
    await expect(gateway.route('probe', 'echo', request)).resolves.toEqual({ status: 'inactive', pluginId: 'probe' });
    await expect(gateway.route('probe', 'missing', request)).rejects.toBeInstanceOf(PhoneRouteMissing);
  });
});

describe('main context for a transport plugin', () => {
  beforeEach(() => void (env.userData = tempDir()));

  it('emits declared window and phone events only while the plugin is on', () => {
    const h = harness();
    const ctx = contextFor(probe, h);
    ctx.channels.emit('shown', 1);
    h.on.delete('probe');
    ctx.channels.emit('shown', 2);
    expect(h.published).toEqual([{ type: 'plugin-event', pluginId: 'probe', name: 'shown', payload: 1 }]);
    expect(() => ctx.channels.emit('quiet' as never, 3 as never)).toThrow(/no window or phone audience/);
  });

  it('keeps secrets in the plugin’s own keystore-encrypted file', () => {
    const ctx = contextFor(probe, harness());
    expect(ctx.secrets.read('devices')).toBeNull();
    ctx.secrets.write('devices', '[1]');
    expect(readSecret('probe-devices')).toBe('[1]');
    expect(ctx.secrets.read('devices')).toBe('[1]');
    ctx.secrets.delete('devices');
    expect(ctx.secrets.read('devices')).toBeNull();
    expect(() => ctx.secrets.read('../x')).toThrow(/must match/);
  });

  it('listens on loopback only when declared, and fetches only declared hosts', async () => {
    const h = harness();
    await expect(contextFor(plain, h).net.listen(0, () => undefined)).rejects.toThrow(/network.loopback/);
    const server = await contextFor(probe, h).net.listen(0, (_req, res) => void res.end('hi'));
    expect(await (await fetch(`http://127.0.0.1:${server.port}/`)).text()).toBe('hi');
    await server.close();
    await expect(contextFor(probe, h).net.fetch('https://elsewhere.example.org/')).rejects.toThrow(/not a declared network host/);
  });

  it("answers 500 for a loopback handler's thrown or rejected error instead of leaving it unhandled", async () => {
    const h = harness();
    const server = await contextFor(probe, h).net.listen(0, async (req) => {
      if (req.url === '/throw') throw new Error('sync');
      await Promise.resolve();
      throw new Error('async');
    });
    for (const path of ['/throw', '/reject']) expect((await fetch(`http://127.0.0.1:${server.port}${path}`)).status).toBe(500);
    await server.close();
  });
});

describe('switch-governed resources', () => {
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('starts while on, stops when off or at quit with the reason, and retries a failed start at the next change', async () => {
    let on = false;
    const log: string[] = [];
    let failOnce = true;
    const failed = vi.fn();
    const r = whileActive('phone', () => on, async () => {
      if (failOnce) {
        failOnce = false;
        throw new Error('port taken');
      }
      log.push('start');
      return (reason) => void log.push(`stop:${reason}`);
    }, failed);
    r.sync();
    on = true;
    r.sync();
    await settle();
    expect(failed).toHaveBeenCalledOnce();
    r.sync();
    r.sync();
    await settle();
    on = false;
    r.sync();
    await settle();
    on = true;
    r.sync();
    await settle();
    await r.stop();
    r.sync();
    await settle();
    expect(log).toEqual(['start', 'stop:off', 'start', 'stop:quit']);
  });
});
