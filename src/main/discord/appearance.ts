// The owner's Discord custom theme, read from their own user settings (protobuf, base64) for Settings → Appearance.
// Field numbers verified 2026-10-02 against a live account: PreloadedUserSettings.appearance (13) → client_theme_settings
// (3) → custom theme (4) { colors (1, repeated "#rrggbb"), gradient_angle (3), base_mix (4) }; appearance.theme (1).
import { CUSTOM_THEME_MIN_COLORS, normalizeCustomTheme, type CustomTheme } from '@shared/settings';
import type { DiscordClient } from './client';
import { fields, message, varintOf } from './settingsProto';

/** Discord's settings-proto type 1: PreloadedUserSettings, where appearance lives. */
const PRELOADED_SETTINGS_PATH = 'users/@me/settings-proto/1';
const FIELD = { appearance: 13, theme: 1, clientTheme: 3, customTheme: 4, colors: 1, gradientAngle: 3, baseMix: 4 } as const;
/** appearance.theme: 1 = dark (verified); 2 = light (assumption: the community discord-protos schema). */
const DISCORD_LIGHT_THEME = 2;

/** The custom theme in a PreloadedUserSettings message; null when the owner has none set in Discord. */
export function customThemeFromSettings(settings: Buffer): CustomTheme | null {
  const appearance = message(fields(settings), FIELD.appearance);
  const custom = message(message(appearance, FIELD.clientTheme), FIELD.customTheme);
  const colors = custom.flatMap((f) => (f.no === FIELD.colors && 'bytes' in f ? [f.bytes.toString('utf8')] : []));
  if (colors.length === 0) return null;
  return normalizeCustomTheme({
    // One colour is a solid theme; a CSS gradient needs two stops.
    colors: colors.length < CUSTOM_THEME_MIN_COLORS ? [colors[0], colors[0]] : colors,
    angle: varintOf(custom, FIELD.gradientAngle) ?? 0,
    baseMix: varintOf(custom, FIELD.baseMix) ?? 0,
    base: varintOf(appearance, FIELD.theme) === DISCORD_LIGHT_THEME ? 'light' : 'dark',
  });
}

/** Reads the owner's Discord custom theme; rejects with a reason the owner can act on when there is none. */
export async function fetchDiscordCustomTheme(owner: DiscordClient): Promise<CustomTheme> {
  const { settings } = await owner.get<{ settings: string }>(PRELOADED_SETTINGS_PATH);
  const theme = customThemeFromSettings(Buffer.from(settings, 'base64'));
  if (!theme) throw new Error('Discord has no custom theme set. Pick one in Discord → Settings → Appearance, then import again.');
  return theme;
}
