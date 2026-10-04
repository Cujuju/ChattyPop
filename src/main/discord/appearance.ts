// The owner's Discord custom theme, read from their own user settings (protobuf, base64) for Settings → Appearance.
// Field numbers verified 2026-10-02 against a live account: PreloadedUserSettings.appearance (13) → client_theme_settings
// (3) → custom theme (4) { colors (1, repeated "#rrggbb"), gradient_angle (3), base_mix (4) }; appearance.theme (1).
import { CUSTOM_THEME_MIN_COLORS, normalizeCustomTheme, type CustomTheme } from '@shared/settings';
import type { DiscordClient } from './client';

/** Discord's settings-proto type 1: PreloadedUserSettings, where appearance lives. */
const PRELOADED_SETTINGS_PATH = 'users/@me/settings-proto/1';
const FIELD = { appearance: 13, theme: 1, clientTheme: 3, customTheme: 4, colors: 1, gradientAngle: 3, baseMix: 4 } as const;
/** appearance.theme: 1 = dark (verified); 2 = light (assumption: the community discord-protos schema). */
const DISCORD_LIGHT_THEME = 2;
const WIRE = { varint: 0, fixed64: 1, bytes: 2, fixed32: 5 } as const;
const FIXED64_BYTES = 8;
const FIXED32_BYTES = 4;
const VARINT_PAYLOAD_BITS = 7;
const VARINT_PAYLOAD_MASK = 0x7f;
const VARINT_MORE = 0x80;
const TAG_WIRE_BITS = 3;
const TAG_WIRE_MASK = 0b111;
/** A varint is at most 10 bytes (64 bits at 7 per byte); more is corruption. */
const VARINT_MAX_BYTES = 10;

type ProtoField = { no: number; varint: number } | { no: number; bytes: Buffer };

/** One message's top-level fields, in order. Throws on a wire type Discord's settings don't use (groups). */
function fields(buf: Buffer): ProtoField[] {
  const out: ProtoField[] = [];
  let p = 0;
  const varint = (): number => {
    let v = 0;
    let mul = 1;
    for (let n = 0; ; n++) {
      if (p >= buf.length || n >= VARINT_MAX_BYTES) throw new Error('Malformed varint in Discord settings.');
      const b = buf[p++]!;
      v += (b & VARINT_PAYLOAD_MASK) * mul;
      if (!(b & VARINT_MORE)) return v;
      mul *= 2 ** VARINT_PAYLOAD_BITS;
    }
  };
  /** Advances past `n` bytes, which must all be present. */
  const take = (n: number): number => {
    if (p + n > buf.length) throw new Error('Truncated field in Discord settings.');
    const at = p;
    p += n;
    return at;
  };
  while (p < buf.length) {
    const tag = varint();
    const no = Math.floor(tag / 2 ** TAG_WIRE_BITS);
    const wire = tag & TAG_WIRE_MASK;
    if (wire === WIRE.varint) out.push({ no, varint: varint() });
    else if (wire === WIRE.bytes) {
      const len = varint();
      const at = take(len);
      out.push({ no, bytes: buf.subarray(at, at + len) });
    } else if (wire === WIRE.fixed64) take(FIXED64_BYTES);
    else if (wire === WIRE.fixed32) take(FIXED32_BYTES);
    else throw new Error(`Unexpected protobuf wire type ${wire} in Discord settings.`);
  }
  return out;
}

const message = (fs: ProtoField[], no: number): ProtoField[] => {
  const f = fs.find((x) => x.no === no && 'bytes' in x);
  return f && 'bytes' in f ? fields(f.bytes) : [];
};
const varintOf = (fs: ProtoField[], no: number): number | undefined => {
  const f = fs.find((x) => x.no === no && 'varint' in x);
  return f && 'varint' in f ? f.varint : undefined;
};

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
