// The account's and this device's chat settings (shared/chatSettings.ts). Until storage and Discord sync land, both read
// their defaults; consumers read only these accessors.
import { createSignal } from 'solid-js';
import { DEFAULT_DEVICE_CHAT_SETTINGS, DEFAULT_DISCORD_CHAT_SETTINGS, type DeviceChatSettings, type DiscordChatSettings } from '@shared/chatSettings';

const [discord] = createSignal<DiscordChatSettings>(DEFAULT_DISCORD_CHAT_SETTINGS);
const [device] = createSignal<DeviceChatSettings>(DEFAULT_DEVICE_CHAT_SETTINGS);

/** The account's chat settings, as Discord syncs them. Reactive. */
export const discordChatSettings = (): DiscordChatSettings => discord();
/** This device's own chat settings. Reactive. */
export const deviceChatSettings = (): DeviceChatSettings => device();
