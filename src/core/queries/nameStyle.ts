// How a name is drawn, decoded from stored columns: a role's colours (roleStyleSql) and a user's Nitro style (users.name_style).
import type { RawDisplayNameStyles } from '@shared/discord';
import { NAME_EFFECTS, type NameEffect, type NameFont } from '@shared/nameFonts';
import { nameFontFrom, parseJson } from './messageExtras';

/** A name's colour (0xRRGGBB, null for the default) and its gradient's stops (null for none). */
export interface NameColors {
  color: number | null;
  gradient: number[] | null;
}

/** A name's role colour, and its gradient where the server draws one (a secondary colour; a tertiary: holographic). */
export function roleColors(json: string | null, enhanced: boolean): NameColors {
  const [primary, secondary, tertiary] = (parseJson(json) as (number | null)[] | null) ?? [];
  if (!primary) return { color: null, gradient: null };
  const gradient = enhanced && secondary != null ? (tertiary != null ? [primary, secondary, tertiary] : [primary, secondary]) : null;
  return { color: primary, gradient };
}

/** A user's whole Nitro name style: font, colours (a gradient only for the Gradient effect) and effect. */
export function nitroStyle(styleJson: string | null): NameColors & { font: NameFont | null; effect: NameEffect | null } {
  const s = parseJson(styleJson) as RawDisplayNameStyles | null;
  const effect = NAME_EFFECTS[(s?.effect_id ?? 0) as keyof typeof NAME_EFFECTS] ?? null;
  const [primary = null] = s?.colors ?? [];
  const gradient = effect === 'gradient' && (s?.colors?.length ?? 0) > 1 ? s!.colors! : null;
  return { font: nameFontFrom(styleJson), effect: primary === null ? null : effect, color: primary, gradient };
}
