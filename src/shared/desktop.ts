// Desktop shell settings and state (Settings → Desktop): the tray, starting at sign-in, the show/hide shortcut and
// updates. Main keeps the settings in a profile file, since they apply before core opens the archive.
import { bool, isObj } from './normalize';
import type { UnreadTotals } from './unread';

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
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  minimizeToTray: false,
  closeToTray: true,
  startHidden: true,
  hotkey: null,
  indicateChat: true,
  indicateAlerts: false,
};

/** Modifiers a hotkey may hold, in accelerator order. Shift alone would take a typed character from every app. */
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

/** A hotkey as Windows names its keys. */
export const hotkeyLabel = (hotkey: string): string => hotkey.replace('Super', 'Win');

/** Where updating stands. Builds not installed from a release (dev runs) can't update. */
export type UpdateStatus =
  | { phase: 'unsupported' }
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'current' }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'ready'; version: string }
  | { phase: 'failed'; message: string };

export interface DesktopState {
  settings: DesktopSettings;
  /** Whether Windows starts ChattyPop at sign-in; null where it can't (a dev run would start bare Electron). */
  openAtLogin: boolean | null;
  /** The hotkey is set but another app holds it. */
  hotkeyTaken: boolean;
  update: UpdateStatus;
  version: string;
}
