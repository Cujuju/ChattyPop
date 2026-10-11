// Settings each remote desktop keeps for itself. Registry-free, so the shared SDK tier can export it.
import { PHONE_UNSHARED_SETTINGS } from './phoneDevice';
import { SETTINGS_KEYS } from './settings';

/**
 * Settings a remote desktop keeps for itself, stored per device by its transport: a window's own place, and how this
 * screen lays out and shows the archive. Every other setting is the server's, shared with its window.
 */
export const REMOTE_DEVICE_SETTINGS: readonly string[] = [
  ...PHONE_UNSHARED_SETTINGS,
  SETTINGS_KEYS.layoutPreset,
  SETTINGS_KEYS.layoutCustom,
  SETTINGS_KEYS.layoutCollapsedPanels,
  SETTINGS_KEYS.layoutSidebarCollapsed,
  SETTINGS_KEYS.archiveDensity,
  // Hiding what is private on one screen (sharing it) must not hide it on the others.
  SETTINGS_KEYS.privacyMode,
  SETTINGS_KEYS.searchSort,
  SETTINGS_KEYS.discordSidebar,
];
const deviceSettings = new Set(REMOTE_DEVICE_SETTINGS);

/** Whether a remote desktop keeps setting `key` for itself (REMOTE_DEVICE_SETTINGS). */
export const isRemoteDeviceSetting = (key: string): boolean => deviceSettings.has(key);
