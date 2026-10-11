// Settings each phone keeps for itself, and the window places it never shares. Registry-free, so the shared SDK tier can export it (tests/installedPlugins.test.ts).
import { normalizeDeviceChatRecord } from './chatSettings';
import { SETTINGS_KEYS } from './settings';

/**
 * Settings each phone keeps for itself, by key, with their normalizers: the transport answers getSetting and setSetting for
 * them per phone (the phone's page relays both), and the desktop's own values never reach a phone.
 */
export const PHONE_DEVICE_SETTINGS: Readonly<Record<string, (v: unknown) => unknown>> = {
  [SETTINGS_KEYS.chatDevice]: normalizeDeviceChatRecord,
};

/** Whether the phone keeps setting `key` for itself (PHONE_DEVICE_SETTINGS). */
export const isPhoneDeviceSetting = (key: string): boolean => Object.hasOwn(PHONE_DEVICE_SETTINGS, key);

/** Host settings that are one window's own place (open tabs, filters, recent channels): the phone neither reads nor writes the PC's. */
export const PHONE_UNSHARED_SETTINGS: readonly string[] = [
  SETTINGS_KEYS.layoutTabPicks,
  SETTINGS_KEYS.channelsBrowsing,
  SETTINGS_KEYS.dmFilter,
  SETTINGS_KEYS.settingsTab,
  SETTINGS_KEYS.settingsSections,
  SETTINGS_KEYS.jevView,
  SETTINGS_KEYS.jevQuery,
  SETTINGS_KEYS.newMessageArchive,
  SETTINGS_KEYS.rulesFilter,
  SETTINGS_KEYS.jevQuerySearch,
  SETTINGS_KEYS.jevQueryFilter,
  SETTINGS_KEYS.recentChannels,
  SETTINGS_KEYS.chatSource,
  SETTINGS_KEYS.archiveChannel,
  SETTINGS_KEYS.archivePlace,
  // The desktop's own chat choices; each phone keeps its own through its transport (PHONE_DEVICE_SETTINGS).
  SETTINGS_KEYS.chatDevice,
];
