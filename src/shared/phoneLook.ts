// A phone's own look (docs/plugin-architecture.md §3, phone points): what its Settings screen chooses, kept per phone by
// the transport, which answers the host settings it stands in for.
import { isObj, oneOf } from './normalize';
import { ARCHIVE_DENSITIES, SETTINGS_KEYS, THEME_IDS, type ArchiveDensity, type ThemeId } from './settings';
import type { AppEvent } from './types/ipc';

/** The phone's text sizes: Apple's Dynamic Type steps, each a ramp in theme/phone.css (html data-text-size). */
export const PHONE_TEXT_SIZES = ['small', 'medium', 'large', 'xlarge'] as const;
export type PhoneTextSize = (typeof PHONE_TEXT_SIZES)[number];

/** A phone's own look. A null theme or density follows the desktop's setting; the text size is the phone's alone. */
export interface PhoneLook {
  theme: ThemeId | null;
  density: ArchiveDensity | null;
  textSize: PhoneTextSize;
}
/** Medium: the ramp theme/phone.css set before phones chose a size. */
export const DEFAULT_PHONE_LOOK: PhoneLook = { theme: null, density: null, textSize: 'medium' };

export function normalizePhoneLook(v: unknown): PhoneLook {
  const look = isObj(v) ? v : {};
  return {
    theme: oneOf(THEME_IDS, look['theme'], null),
    density: oneOf(ARCHIVE_DENSITIES, look['density'], null),
    textSize: oneOf(PHONE_TEXT_SIZES, look['textSize'], DEFAULT_PHONE_LOOK.textSize),
  };
}

/** Host settings a phone's look stands in for: the transport answers them, and their change events, per phone. */
export const PHONE_LOOK_KEYS = [SETTINGS_KEYS.appearance, SETTINGS_KEYS.archiveDensity] as const;

/** Setting `key` as a phone with `look` reads it, from `value` as the phone may read it (phoneSetting). */
export function phoneLookSetting(key: string, value: unknown, look: PhoneLook): unknown {
  if (key === SETTINGS_KEYS.appearance && look.theme) return { ...(isObj(value) ? value : {}), theme: look.theme };
  if (key === SETTINGS_KEYS.archiveDensity && look.density) return look.density;
  return value;
}

/** An event, as the phone gets it (phoneAppEvent), for a phone with `look`: a look key's change carries its own choice. `e` itself when unchanged. */
export function phoneLookEvent(e: AppEvent, look: PhoneLook): AppEvent {
  if (e.type !== 'setting-changed') return e;
  const value = phoneLookSetting(e.key, e.value, look);
  return value === e.value ? e : { ...e, value };
}
