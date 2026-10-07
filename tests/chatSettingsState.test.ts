// The renderer's chat settings store: what a device shows, where each change goes (the account while syncing, else the
// device), spoilers where the owner moderates; and the phone's own record crossing only through its transport.
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DEVICE_CHAT_RECORD, DEFAULT_SYNCED_CHAT_SETTINGS, type DeviceChatRecord, type DeviceChatSettings, type DiscordChatSettings, type SyncedChatSettings } from '@shared/chatSettings';
import type { AppEvent } from '@shared/contract';
import { PHONE_DEVICE_SETTINGS, PHONE_DISCORD_METHODS, isPhoneDeviceSetting, phoneAppEvent, phoneSetting, type PhoneCall } from '@shared/phone';
import { SETTINGS_KEYS } from '@shared/settings';

vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
vi.mock('solid-js/store', () => createRequire(import.meta.url)('solid-js/store/dist/store.cjs') as Record<string, unknown>);

const ACCOUNT: SyncedChatSettings = { ...DEFAULT_SYNCED_CHAT_SETTINGS, renderReactions: false };
const CHANNEL = '300000000000000001';
const host = vi.hoisted(() => ({
  stored: new Map<string, unknown>(),
  writes: [] as [string, unknown][],
  discordWrites: [] as unknown[],
  refuse: false,
  moderates: [] as string[],
  emit: (_e: unknown): void => undefined,
}));
vi.mock('@/api', () => ({
  api: {
    core: {
      getSetting: async (key: string) => host.stored.get(key),
      setSetting: async (key: string, value: unknown) => void host.writes.push([key, value]),
      ownerModerates: async (channelId: string) => {
        host.moderates.push(channelId);
        return true;
      },
    },
    discord: {
      setChatSettings: async (change: unknown) => {
        host.discordWrites.push(change);
        if (host.refuse) throw new Error('Discord said no.');
      },
    },
    onEvent: (listener: (e: unknown) => void) => {
      host.emit = listener;
      return () => undefined;
    },
  },
}));

host.stored.set(SETTINGS_KEYS.discordChat, ACCOUNT);
// Renderer module: imported by path so the node type-check doesn't follow it.
const statePath = '../src/renderer/src/state/chatSettings';
const chat = (await import(statePath)) as {
  discordChatSettings(): DiscordChatSettings;
  deviceChatSettings(): DeviceChatSettings;
  changeDiscordChatSettings(change: Partial<SyncedChatSettings>): Promise<void>;
  changeDeviceChatSettings(change: Partial<DeviceChatSettings>): Promise<void>;
  setSyncAcrossClients(on: boolean): Promise<void>;
  spoilersShownIn(channelId: string): boolean;
};
const settle = (): Promise<void> => new Promise((r) => setTimeout(r));
const changed = (key: string, value: unknown): void => host.emit({ type: 'setting-changed', key, value } satisfies AppEvent);

beforeEach(async () => {
  await settle();
  host.writes = [];
  host.discordWrites = [];
  host.refuse = false;
  changed(SETTINGS_KEYS.discordChat, ACCOUNT);
  changed(SETTINGS_KEYS.chatDevice, DEFAULT_DEVICE_CHAT_RECORD);
});

describe('the chat settings store', () => {
  it('shows the account’s settings while syncing, and follows their changes', () => {
    expect(chat.discordChatSettings()).toEqual({ ...ACCOUNT, syncAcrossClients: true });
    changed(SETTINGS_KEYS.discordChat, { ...ACCOUNT, renderEmbeds: false });
    expect(chat.discordChatSettings().renderEmbeds).toBe(false);
    expect(chat.deviceChatSettings()).toEqual(DEFAULT_DEVICE_CHAT_RECORD.device);
  });

  it('a change while syncing goes to the account and shows at once; refused, it reverts', async () => {
    await chat.changeDiscordChatSettings({ spoilers: 'always' });
    expect(host.discordWrites).toEqual([{ spoilers: 'always' }]);
    expect(host.writes).toEqual([]);

    host.refuse = true;
    const write = chat.changeDiscordChatSettings({ renderEmbeds: false });
    expect(chat.discordChatSettings().renderEmbeds).toBe(false);
    await expect(write).rejects.toThrow('Discord said no.');
    expect(chat.discordChatSettings().renderEmbeds).toBe(true);
  });

  it('sync off keeps the account’s settings on this device; its changes stay here', async () => {
    await chat.setSyncAcrossClients(false);
    const [key, stored] = host.writes.at(-1)!;
    expect(key).toBe(SETTINGS_KEYS.chatDevice);
    expect((stored as DeviceChatRecord).unsynced).toEqual(ACCOUNT);
    await chat.changeDiscordChatSettings({ renderEmbeds: false });
    expect(host.discordWrites).toEqual([]);
    expect((host.writes.at(-1)![1] as DeviceChatRecord).unsynced.renderEmbeds).toBe(false);
    // The account's later changes don't reach a device that isn't syncing.
    changed(SETTINGS_KEYS.discordChat, { ...ACCOUNT, convertEmoticons: false });
    expect(chat.discordChatSettings().convertEmoticons).toBe(true);
  });

  it('device settings change this device’s record only', async () => {
    await chat.changeDeviceChatSettings({ videoQuality: 'dataSaver' });
    const [key, stored] = host.writes.at(-1)!;
    expect(key).toBe(SETTINGS_KEYS.chatDevice);
    expect((stored as DeviceChatRecord).device).toEqual({ ...DEFAULT_DEVICE_CHAT_RECORD.device, videoQuality: 'dataSaver' });
    expect(chat.deviceChatSettings().videoQuality).toBe('dataSaver');
  });

  it('spoilers "on servers I moderate" ask core once per channel', async () => {
    expect(chat.spoilersShownIn(CHANNEL)).toBe(false);
    expect(host.moderates).toEqual([]);
    changed(SETTINGS_KEYS.discordChat, { ...ACCOUNT, spoilers: 'moderated' });
    expect(chat.spoilersShownIn(CHANNEL)).toBe(false);
    await settle();
    expect(chat.spoilersShownIn(CHANNEL)).toBe(true);
    expect(host.moderates).toEqual([CHANNEL]);
  });
});

describe('the phone’s chat settings', () => {
  it('each phone keeps its own record: never the desktop’s, and its writes go to the transport', async () => {
    expect(isPhoneDeviceSetting(SETTINGS_KEYS.chatDevice)).toBe(true);
    expect(PHONE_DEVICE_SETTINGS[SETTINGS_KEYS.chatDevice]!(null)).toEqual(DEFAULT_DEVICE_CHAT_RECORD);
    expect(phoneSetting(SETTINGS_KEYS.chatDevice, DEFAULT_DEVICE_CHAT_RECORD)).toBeUndefined();
    expect(phoneAppEvent({ type: 'setting-changed', key: SETTINGS_KEYS.chatDevice, value: DEFAULT_DEVICE_CHAT_RECORD })).toBeNull();
    // The account's settings reach the phone, and it may write them while it syncs.
    expect(phoneSetting(SETTINGS_KEYS.discordChat, ACCOUNT)).toEqual(ACCOUNT);
    expect(PHONE_DISCORD_METHODS).toContain('setChatSettings');

    const { createPhoneRendererApi } = await import('../src/plugin-sdk/renderer/shell/phoneApi');
    const calls: PhoneCall[] = [];
    const phone = createPhoneRendererApi({ call: async (c) => void calls.push(c), listen: () => undefined });
    await phone.core.setSetting(SETTINGS_KEYS.chatDevice, DEFAULT_DEVICE_CHAT_RECORD);
    await phone.core.setSetting(SETTINGS_KEYS.archiveDensity, 'compact');
    expect(calls).toEqual([{ group: 'core', method: 'setSetting', params: [SETTINGS_KEYS.chatDevice, DEFAULT_DEVICE_CHAT_RECORD] }]);
  });
});
