// The account's and this device's chat settings (shared/chatSettings.ts): the account's as main last read them from
// Discord, this device's as stored (a phone's by its transport). Consumers read only these accessors and change functions.
import { createSignal } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { api } from '@/api';
import { createSetting } from '@plugin-sdk/renderer/settings';
import {
  DEFAULT_DEVICE_CHAT_RECORD,
  DEFAULT_SYNCED_CHAT_SETTINGS,
  normalizeDeviceChatRecord,
  normalizeSyncedChatSettings,
  routeChatChange,
  shownChatSettings,
  spoilersUncovered,
  withSyncAcrossClients,
  type DeviceChatRecord,
  type DeviceChatSettings,
  type DiscordChatSettings,
  type SyncedChatSettings,
} from '@shared/chatSettings';
import { SETTINGS_KEYS } from '@shared/settings';
import { onAppEvent } from './events';

const [account] = createSetting<SyncedChatSettings>(SETTINGS_KEYS.discordChat, DEFAULT_SYNCED_CHAT_SETTINGS, normalizeSyncedChatSettings);
const [record, setRecord] = createSetting<DeviceChatRecord>(SETTINGS_KEYS.chatDevice, DEFAULT_DEVICE_CHAT_RECORD, normalizeDeviceChatRecord);
/** Account changes on their way to Discord, shown at once; dropped when Discord answers (its settings then show) or refuses. */
const [pending, setPending] = createSignal<Partial<SyncedChatSettings>>({});

/** The account's chat settings as this device shows them: the account's while it syncs, else its own. Reactive. */
export const discordChatSettings = (): DiscordChatSettings => shownChatSettings({ ...account(), ...pending() }, record());
/** This device's own chat settings. Reactive. */
export const deviceChatSettings = (): DeviceChatSettings => record().device;

/** Changes Discord chat settings as this device shows them: written to the account while syncing, else kept here. Rejects with Discord's reason. */
export async function changeDiscordChatSettings(change: Partial<SyncedChatSettings>): Promise<void> {
  const target = routeChatChange(record(), change);
  if ('record' in target) return setRecord(target.record);
  setPending((p) => ({ ...p, ...change }));
  try {
    await api.discord.setChatSettings(change);
  } finally {
    // A later change to the same setting keeps showing until its own answer.
    setPending((p) => Object.fromEntries(Object.entries(p).filter(([key, v]) => change[key as keyof SyncedChatSettings] !== v)));
  }
}

/** Turns syncing with the account on or off for this device. */
export const setSyncAcrossClients = (on: boolean): Promise<void> => setRecord(withSyncAcrossClients(record(), on, account()));

export const changeDeviceChatSettings = (change: Partial<DeviceChatSettings>): Promise<void> => setRecord({ ...record(), device: { ...record().device, ...change } });

/** Channels where the owner has Manage Messages, as core last answered; read again after a change to members or roles. */
const [moderates, setModerates] = createStore<Record<string, boolean>>({});
const asked = new Set<string>();
const forgetModeration = (): void => {
  asked.clear();
  setModerates(reconcile({}));
};
onAppEvent('archive-changed', (e) => e.namesChanged && forgetModeration());
onAppEvent('self-changed', forgetModeration);

/** Whether spoilers in `channelId` show uncovered (Discord's "Show spoiler content"). Reactive. */
export function spoilersShownIn(channelId: string): boolean {
  const mode = discordChatSettings().spoilers;
  if (mode !== 'moderated') return spoilersUncovered(mode, false);
  if (!asked.has(channelId)) {
    asked.add(channelId);
    void api.core.ownerModerates(channelId).then(
      (yes) => setModerates(channelId, yes),
      () => asked.delete(channelId),
    );
  }
  return spoilersUncovered(mode, moderates[channelId] ?? false);
}
