// The hub carries remote desktops (main/phone/hub.ts): their calls as a window's, the server's screen and disk
// refused, their events and the transport's pairing prompts.
import { describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '@shared/contract';

vi.mock('virtual:bundled-plugins/shared', async () => ({ default: (await import('./aRemoteEvents')).REMOTE_EVENTS, catalog: null }));

const { PhoneCallRefused, PhoneHub } = await import('../src/main/phone/hub');
const { APP_RESTART_CHANNEL, MAIN_INVOKE } = await import('@shared/contract');
const { SETTINGS_KEYS } = await import('@shared/settings');

function harness() {
  const core = { call: vi.fn(async (method: string, ...params: unknown[]) => ({ core: method, params })) };
  const discord = { send: vi.fn(async (...params: unknown[]) => ({ discord: 'send', params })) };
  const main = vi.fn(async (channel: string, args: readonly unknown[]) => ({ main: channel, args }));
  const hub = new PhoneHub({ core: core as never, discord: () => discord as never, main, media: async (url) => new Response(url.href), active: () => true });
  return { hub, core, discord, main };
}

describe('remote desktop calls', () => {
  it('makes every core call the window makes, settings writes included, which the phone may not', async () => {
    const { hub, core } = harness();
    await hub.desktopGateway.call('core', 'setSetting', ['k', 1]);
    expect(core.call).toHaveBeenCalledWith('setSetting', 'k', 1);
    await expect(hub.gateway.call('core', 'setChannelPolicy', [])).rejects.toBeInstanceOf(PhoneCallRefused);
    await hub.desktopGateway.call('core', 'setChannelPolicy', ['c', 'local']);
    expect(core.call).toHaveBeenCalledWith('setChannelPolicy', 'c', 'local');
    await expect(hub.desktopGateway.call('core', 'pluginCall', ['renderer', 'p', 'x', []])).rejects.toBeInstanceOf(PhoneCallRefused);
  });

  it("calls plugins through main's window calls, which stamp them as a window's", async () => {
    const { hub, main } = harness();
    await hub.desktopGateway.call('plugins', 'callCore', ['relay', 'go', [1]]);
    expect(main).toHaveBeenLastCalledWith(MAIN_INVOKE.plugins.callCore, ['relay', 'go', [1]]);
    await hub.desktopGateway.call('plugins', 'callMain', ['relay', 'go', []]);
    expect(main).toHaveBeenLastCalledWith(MAIN_INVOKE.plugins.callMain, ['relay', 'go', []]);
  });

  it("posts through the phone's gated Discord calls, and reaches the rest of Discord by channel", async () => {
    const { hub, discord, main } = harness();
    await hub.desktopGateway.call('discord', 'send', [{ channelId: 'c' }]);
    expect(discord.send).toHaveBeenCalledWith({ channelId: 'c' });
    await hub.desktopGateway.call('discord', 'setOptIn', ['c', true]);
    expect(main).toHaveBeenLastCalledWith(MAIN_INVOKE.discord.setOptIn, ['c', true]);
    await expect(hub.desktopGateway.call('discord', 'setSlot', [{}])).rejects.toBeInstanceOf(PhoneCallRefused);
    await expect(hub.gateway.call('discord', 'setOptIn', ['c', true])).rejects.toBeInstanceOf(PhoneCallRefused);
  });

  it("restarts the server and installs plugins, but never reaches the server's screen or disk", async () => {
    const { hub, main } = harness();
    await hub.desktopGateway.call('main', APP_RESTART_CHANNEL, []);
    await hub.desktopGateway.call('main', MAIN_INVOKE.marketplace.install, ['repo', 'id', null]);
    expect(main).toHaveBeenCalledTimes(2);
    for (const channel of [MAIN_INVOKE.storage.move, MAIN_INVOKE.rules.pickFile, MAIN_INVOKE.media.savePdf, MAIN_INVOKE.desktop.setBadge]) {
      await expect(hub.desktopGateway.call('main', channel, []), channel).rejects.toBeInstanceOf(PhoneCallRefused);
    }
  });
});

describe('remote desktop events and pairing', () => {
  const transport = () => ({ broadcast: vi.fn(), notify: vi.fn(), broadcastDesktop: vi.fn(), startPairing: vi.fn(() => ({ code: '123456', url: null, expiresAt: 1 })) });
  const pluginEvent = (name: string): AppEvent => ({ type: 'plugin-event', pluginId: 'relay', name, payload: null });

  it('hands remote desktops what windows get, and phones what phones get', () => {
    const { hub } = harness();
    const to = transport();
    const link = hub.connect('companion', to);
    expect(link.desktopGateway).toBe(hub.desktopGateway);
    hub.broadcast(pluginEvent('desk'));
    hub.broadcast(pluginEvent('pocket'));
    expect(to.broadcastDesktop.mock.calls.map(([e]) => (e as { name: string }).name)).toEqual(['desk']);
    expect(to.broadcast.mock.calls.map(([e]) => (e as { name: string }).name)).toEqual(['pocket']);
    // A desktop keeps its layout for itself: the server's change isn't its.
    hub.broadcast({ type: 'setting-changed', key: SETTINGS_KEYS.layoutPreset, value: 'reading' });
    expect(to.broadcastDesktop).toHaveBeenCalledTimes(1);
  });

  it('serves a transport that carries phones only', () => {
    const { hub } = harness();
    const to = { broadcast: vi.fn(), notify: vi.fn() };
    hub.connect('companion', to);
    expect(() => hub.broadcast({ type: 'status-changed' })).not.toThrow();
    expect(to.broadcast).toHaveBeenCalledOnce();
  });

  it("asks the connected transport for a pairing code, and has none without one", async () => {
    const { hub } = harness();
    expect(await hub.startPairing()).toBeNull();
    const link = hub.connect('companion', transport());
    expect(await hub.startPairing()).toEqual({ code: '123456', url: null, expiresAt: 1 });
    link.disconnect();
    expect(await hub.startPairing()).toBeNull();
  });
});
