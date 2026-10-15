// What a remote desktop may reach (src/shared/remote.ts): every window call is local, crossing or refused, and the
// settings it keeps for itself are its own.
import { describe, expect, it, vi } from 'vitest';

vi.mock('virtual:bundled-plugins/shared', async () => ({ default: (await import('./aRemoteEvents')).REMOTE_EVENTS, catalog: null }));

const { APP_RESTART_CHANNEL, MAIN_INVOKE, PAGE_ERROR_CHANNEL, RENDERER_CORE_METHODS } = await import('@shared/contract');
const { SETTINGS_KEYS } = await import('@shared/settings');
const { PHONE_HOST_SETTINGS, PHONE_UNSHARED_SETTINGS } = await import('@shared/phone');
const remote = await import('@shared/remote');

const channelsOf = (group: keyof typeof MAIN_INVOKE): string[] => Object.values<string>(MAIN_INVOKE[group]);

describe('remote desktop calls', () => {
  it('classifies every window channel once: crossing, local, refused, or a Discord or plugin call', () => {
    const discord = channelsOf('discord');
    const plugins = channelsOf('plugins');
    const others = (Object.keys(MAIN_INVOKE) as (keyof typeof MAIN_INVOKE)[]).filter((g) => g !== 'discord' && g !== 'plugins').flatMap(channelsOf);
    for (const channel of others) {
      const lists = [remote.REMOTE_MAIN_CALLS, remote.REMOTE_LOCAL_MAIN_CALLS, remote.REMOTE_REFUSED_MAIN_CALLS].filter((l) => l.includes(channel));
      expect(lists, channel).toHaveLength(1);
    }
    for (const channel of [...discord, ...plugins]) expect(remote.remoteMayCallMain(channel), channel).toBe(false);
    expect(remote.REMOTE_DISCORD_METHODS).toHaveLength(discord.length);
  });

  it('lets a remote desktop restart the server but not reach its screen or disk', () => {
    expect(remote.remoteMayCallMain(APP_RESTART_CHANNEL)).toBe(true);
    expect(remote.remoteMayCallMain(PAGE_ERROR_CHANNEL)).toBe(true);
    expect(remote.remoteMayCallMain(MAIN_INVOKE.storage.move)).toBe(false);
    expect(remote.remoteMayCallMain(MAIN_INVOKE.rules.pickFile)).toBe(false);
    expect(remote.remoteMayCallMain(MAIN_INVOKE.marketplace.installLocal)).toBe(true);
    expect(remote.remoteMayCallMain(MAIN_INVOKE.openRouter.signIn)).toBe(false);
    expect(remote.remoteMayCallMain(MAIN_INVOKE.marketplace.install)).toBe(true);
    expect(remote.remoteMayCallMain(MAIN_INVOKE.storage.info)).toBe(true);
  });

  it('lets a remote desktop make every core call the window makes, and only those', () => {
    for (const m of RENDERER_CORE_METHODS) expect(remote.remoteMayCallCore(m)).toBe(!(remote.SERVER_SCREEN_CORE_METHODS as readonly string[]).includes(m));
    expect(remote.remoteMayCallCore('pluginCall')).toBe(false);
    expect(remote.remoteMayCallCore('closeArchive')).toBe(false);
  });

  it('keeps the live pane on the device: no Discord call places it', () => {
    for (const m of ['setSlot', 'setSidebar', 'openChannel']) expect(remote.remoteMayCallDiscord(m)).toBe(false);
    expect(remote.remoteMayCallDiscord('setOptIn')).toBe(true);
    expect(remote.remoteMayCallDiscord('startDm')).toBe(true);
  });
});

describe('remote desktop settings', () => {
  const keys = new Set<string>(Object.values(SETTINGS_KEYS));

  it('keeps only known settings per device, every window place among them', () => {
    for (const key of remote.REMOTE_DEVICE_SETTINGS) expect(keys.has(key), key).toBe(true);
    for (const key of PHONE_UNSHARED_SETTINGS) expect(remote.isRemoteDeviceSetting(key), key).toBe(true);
  });

  it('keeps per device what the phone only views, except the account’s chat settings, which Discord holds', () => {
    for (const [key, share] of Object.entries(PHONE_HOST_SETTINGS)) {
      if (share !== 'view' || key === SETTINGS_KEYS.discordChat) continue;
      expect(remote.isRemoteDeviceSetting(key), key).toBe(true);
    }
    expect(remote.isRemoteDeviceSetting(SETTINGS_KEYS.discordChat)).toBe(false);
    expect(remote.isRemoteDeviceSetting(SETTINGS_KEYS.appearance)).toBe(false);
  });
});

describe('remote desktop events', () => {
  const plugin = (name: string) => ({ type: 'plugin-event', pluginId: 'relay', name, payload: null }) as const;

  it('gets the plugin events windows get, never a phone-only one', () => {
    expect(remote.remoteAppEvent(plugin('both'))).not.toBeNull();
    expect(remote.remoteAppEvent(plugin('desk'))).not.toBeNull();
    expect(remote.remoteAppEvent(plugin('pocket'))).toBeNull();
  });

  it("gets the server's setting changes except those it keeps for itself", () => {
    const shared = { type: 'setting-changed', key: SETTINGS_KEYS.appearance, value: {} } as const;
    expect(remote.remoteAppEvent(shared)).toEqual(shared);
    expect(remote.remoteAppEvent({ type: 'setting-changed', key: SETTINGS_KEYS.layoutPreset, value: 'reading' })).toBeNull();
    expect(remote.remoteAppEvent({ type: 'status-changed' })).toEqual({ type: 'status-changed' });
  });
});
