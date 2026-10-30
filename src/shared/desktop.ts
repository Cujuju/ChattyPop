// Desktop settings cover tray, sign-in startup, shortcuts and updates. Main stores them in profile files before archive startup.
import type { UpdateStatus } from '@cujuju/electron-updates';
import { bool, isObj } from './normalize';
import type { UnreadTotals } from './unread';
import { UPDATE_CHANNELS, type UpdateChannel } from './updateFeed';

export interface DesktopSettings {
  /** Minimizing the main window hides it to the tray. */
  minimizeToTray: boolean;
  /** The window's own close command (title bar, Alt+F4, taskbar) hides it to the tray; the tray's Quit exits. */
  closeToTray: boolean;
  /** Started by Windows at sign-in: stays in the tray until opened. */
  startHidden: boolean;
  /** System-wide shortcut that shows or hides the main window (an Electron accelerator); null for none. */
  hotkey: string | null;
  /** The taskbar and tray show a dot while Discord chat is unread. */
  indicateChat: boolean;
  /** The taskbar and tray show a dot while alerts are unread; off by default, since the bell already shows them. */
  indicateAlerts: boolean;
  /** Nightly also takes prereleases, published on each push; stable takes promoted ones only. */
  updateChannel: UpdateChannel;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  minimizeToTray: false,
  closeToTray: true,
  startHidden: true,
  hotkey: null,
  indicateChat: true,
  indicateAlerts: false,
  updateChannel: 'stable',
};

/** Allowed accelerator modifiers in order. Excludes Shift-only shortcuts that intercept typed characters globally. */
const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Super'] as const;
const TAKING_MODIFIERS = new Set<string>(['Ctrl', 'Alt', 'Super']);
const HOTKEY_KEY = /^(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4])|Space)$/;

/** Whether `v` is a hotkey this app makes: modifiers in MODIFIERS order (one of Ctrl, Alt or Super), then one key. */
export function isHotkey(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const parts = v.split('+');
  const key = parts.pop() ?? '';
  const order = parts.map((m) => MODIFIERS.indexOf(m as (typeof MODIFIERS)[number]));
  return (
    HOTKEY_KEY.test(key) &&
    order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!)) &&
    parts.some((m) => TAKING_MODIFIERS.has(m))
  );
}

export const normalizeDesktopSettings = (v: unknown): DesktopSettings => {
  const o = isObj(v) ? v : {};
  return {
    minimizeToTray: bool(o['minimizeToTray'], DEFAULT_DESKTOP_SETTINGS.minimizeToTray),
    closeToTray: bool(o['closeToTray'], DEFAULT_DESKTOP_SETTINGS.closeToTray),
    startHidden: bool(o['startHidden'], DEFAULT_DESKTOP_SETTINGS.startHidden),
    hotkey: isHotkey(o['hotkey']) ? o['hotkey'] : DEFAULT_DESKTOP_SETTINGS.hotkey,
    indicateChat: bool(o['indicateChat'], DEFAULT_DESKTOP_SETTINGS.indicateChat),
    indicateAlerts: bool(o['indicateAlerts'], DEFAULT_DESKTOP_SETTINGS.indicateAlerts),
    updateChannel: (UPDATE_CHANNELS as readonly unknown[]).includes(o['updateChannel']) ? (o['updateChannel'] as UpdateChannel) : DEFAULT_DESKTOP_SETTINGS.updateChannel,
  };
};

/** `unread` with each kind the owner turned off as zero: what the taskbar and tray show. */
export const indicatedUnread = (unread: UnreadTotals, s: DesktopSettings): UnreadTotals => ({
  chat: s.indicateChat ? unread.chat : 0,
  alerts: s.indicateAlerts ? unread.alerts : 0,
});

/** A pressed key as a keydown event reports it. */
export interface KeyChord {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** The hotkey a key press makes, or null when it can't be one (no Ctrl, Alt or Win; a modifier or unsupported key). */
export function hotkeyOf(e: KeyChord): string | null {
  const key = /^Key([A-Z])$/.exec(e.code)?.[1] ?? /^Digit(\d)$/.exec(e.code)?.[1] ?? (HOTKEY_KEY.test(e.code) ? e.code : null);
  if (!key) return null;
  const held = { Ctrl: e.ctrlKey, Alt: e.altKey, Shift: e.shiftKey, Super: e.metaKey };
  const hotkey = [...MODIFIERS.filter((m) => held[m]), key].join('+');
  return isHotkey(hotkey) ? hotkey : null;
}

/** The desktop system main runs on, for wording that names its parts: its keys, its tray, its sign-in. */
export type DesktopPlatform = 'windows' | 'mac' | 'linux';

/** Node's `process.platform` as a desktop platform; anything but Windows and macOS reads as Linux. */
export const desktopPlatform = (nodePlatform: string): DesktopPlatform => (nodePlatform === 'win32' ? 'windows' : nodePlatform === 'darwin' ? 'mac' : 'linux');

type HotkeyModifier = 'Ctrl' | 'Alt' | 'Super';
/** Each system's names for the accelerator modifiers a hotkey may hold. */
const MODIFIER_NAMES: Record<DesktopPlatform, Record<HotkeyModifier, string>> = {
  windows: { Ctrl: 'Ctrl', Alt: 'Alt', Super: 'Win' },
  mac: { Ctrl: 'Control', Alt: 'Option', Super: 'Command' },
  linux: { Ctrl: 'Ctrl', Alt: 'Alt', Super: 'Super' },
};

/** A hotkey as `platform` names its keys. */
export const hotkeyLabel = (hotkey: string, platform: DesktopPlatform = 'windows'): string =>
  hotkey
    .split('+')
    .map((part) => MODIFIER_NAMES[platform][part as HotkeyModifier] ?? part)
    .join('+');

/** The modifiers a hotkey needs one of, as a sentence names them: "Ctrl, Alt or Win". */
export const modifierList = (platform: DesktopPlatform = 'windows'): string => {
  const names = MODIFIER_NAMES[platform];
  return `${names.Ctrl}, ${names.Alt} or ${names.Super}`;
};

/** What Settings calls the parts of the desktop that differ by system. */
export interface DesktopWords {
  /** The switch that starts the app with the owner's session. */
  startAtSignIn: string;
  /** Where a hidden window's icon stays, after "to" or "in": "the tray". */
  tray: string;
  /** The same as a heading: "Tray". */
  trayTitle: string;
  /** Where the unread dots show. */
  unreadDots: string;
  /** What guards the archive key, completing "the key is …". */
  keyGuard: string;
}

const DESKTOP_WORDS: Record<DesktopPlatform, DesktopWords> = {
  windows: {
    startAtSignIn: 'Start at Windows sign-in',
    tray: 'the tray',
    trayTitle: 'Tray',
    unreadDots: 'on the tray and taskbar icons.',
    keyGuard: 'protected by your Windows sign-in, so only this Windows account can open the archive.',
  },
  mac: {
    startAtSignIn: 'Start at login',
    tray: 'the menu bar',
    trayTitle: 'Menu bar',
    unreadDots: 'on the menu bar icon. The Dock icon shows the count.',
    keyGuard: 'kept in your macOS keychain, so only this Mac account can open the archive.',
  },
  linux: {
    startAtSignIn: 'Start at sign-in',
    tray: 'the tray',
    trayTitle: 'Tray',
    unreadDots: 'on the tray icon.',
    keyGuard: 'kept in your desktop keyring, so only this account can open the archive.',
  },
};

export const desktopWords = (platform: DesktopPlatform = 'windows'): DesktopWords => DESKTOP_WORDS[platform];

/** Where updating stands. Builds not installed from a release (dev runs) can't update. */
export type { UpdateStatus };

/** The status before main's updater exists. */
export const NO_UPDATER: UpdateStatus = { state: 'unavailable', reason: 'Installed builds only.' };

export interface DesktopState {
  /** The system main runs on. */
  platform: DesktopPlatform;
  settings: DesktopSettings;
  /** Whether the system starts the app at sign-in; null where unsupported, including dev. */
  openAtLogin: boolean | null;
  /** The hotkey is set but another app holds it. */
  hotkeyTaken: boolean;
  update: UpdateStatus;
  version: string;
}
