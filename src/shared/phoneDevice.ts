// Settings each phone keeps for itself. Registry-free, so the shared SDK tier can export it (tests/installedPlugins.test.ts).
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
