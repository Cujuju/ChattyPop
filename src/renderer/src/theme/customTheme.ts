// A custom gradient theme's tokens, derived from the owner's stops the way Discord's custom themes are: a base colour
// (the darkest stop's hue for a dark base, the lightest's for a light one) veils the gradient by `baseMix`. Panels and
// chrome wear that veil over the gradient; opaque surfaces are the veil over the stops' average. Text and accent are
// pushed until they meet AA on the worst surface, so any stops stay readable. Tokens not derived come from the base theme.
import { DEFAULT_CUSTOM_THEME, type CustomTheme } from '@shared/settings';
import { AA_TARGET, AA_TEXT, FULL, MAX_CHANNEL, PUSH_STEP, average, contrast, hexToRgb, hsl, hueSatLight, luminance, mix, readable, rgbToHex, type Rgb } from './color';

export { AA_TEXT, contrast };

/** Base colour lightness, percent: Discord's computed base colours (dark rgb(17,0,26) is L 5%; light rgb(248,204,255) is L 90%). */
const BASE_LIGHTNESS = { dark: 5, light: 90 } as const;
/** Text levels' starting lightness, percent, before contrast pushes them: near Discord's text colours (L 97% / 1%). */
const TEXT_LIGHTNESS = { dark: { t1: 95, t2: 84, muted: 68 }, light: { t1: 8, t2: 22, muted: 36 } } as const;
/** Text saturation cap, percent: tinted by the theme's hue yet near neutral, so text never reads as the accent (night's text is ~11%). */
const TEXT_SATURATION_MAX = 25;
/** Each surface level's share of text colour mixed into the base, percent: night's step from surface-0 to surface-5. */
const SURFACE_LIFT = [0, 2, 4, 6, 10, 16] as const;
/** Surface-cited: a step past surface-2 toward the accent, as night's cited row sits between surface-2 and -3. */
const CITED_ACCENT_SHARE = 8;
/** Border shares of text colour over surface-1, percent: subtle, faint, normal, strong (night's border ramp). */
const BORDER_LIFT = { faint: 5, subtle: 8, normal: 12, strong: 22 } as const;
/** Accent hover: this share of text colour over the accent, percent. */
const ACCENT_HOVER_SHARE = 20;

/** The gradient as a CSS image. */
export const gradientImage = (t: CustomTheme): string => `linear-gradient(${t.angle}deg, ${t.colors.join(', ')})`;
/** The gradient as a background value, fixed to the viewport so every painter shows one continuous gradient. */
const gradientPaint = (t: CustomTheme): string => `${gradientImage(t)} fixed`;

/**
 * Foregrounds a custom theme inherits from its base theme (sections, links, status, platforms). Each was checked only on
 * the base theme's surfaces, so it is re-pushed to read on the derived ones.
 */
export const INHERITED_FOREGROUNDS = [
  ...['summary', 'provider', 'alerts', 'links', 'chat', 'plans', 'tags', 'rules', 'stats'].map((s) => `--cp-section-${s}`),
  ...['youtube', 'reddit', 'instagram', 'tiktok', 'twitch'].map((p) => `--cp-platform-${p}`),
  '--cp-info',
  '--cp-link-hover',
  '--cp-accent-2',
  '--cp-success',
  '--cp-danger',
];

const HEX = /^#[0-9a-f]{6}$/i;
/** Ternary-search steps for a blend's darkest point: (2/3)^40 of a segment, far below one 8-bit step. */
const DARKEST_SEARCH_STEPS = 40;
const THIRD = 1 / 3;

/** `b` at `pct` percent over `a`, unrounded, for searching along a blend. */
const mixExact = (a: Rgb, b: Rgb, pct: number): Rgb => a.map((v, i) => v + (b[i]! - v) * (pct / FULL)) as unknown as Rgb;

/**
 * The darkest colour `veil` at `veilPct` makes over the blend from `a` to `b`. Luminance along an sRGB blend is convex,
 * so its minimum may lie between the stops (its maximum never does); ternary search finds it.
 */
function darkestVeiledPoint(a: Rgb, b: Rgb, veil: Rgb, veilPct: number): Rgb {
  const at = (t: number): Rgb => mixExact(mixExact(a, b, t * FULL), veil, veilPct);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < DARKEST_SEARCH_STEPS; i++) {
    const m1 = lo + (hi - lo) * THIRD;
    const m2 = hi - (hi - lo) * THIRD;
    if (luminance(at(m1)) < luminance(at(m2))) hi = m2;
    else lo = m1;
  }
  return at((lo + hi) / 2).map(Math.round) as unknown as Rgb;
}

interface Layers {
  ground: Rgb;
  surfaces: Rgb[];
  /** Every colour text can sit on: the opaque surfaces and the veiled panels and chrome at their worst points. */
  backgrounds: Rgb[];
  baseMix: number;
}

interface Derived extends Layers {
  h: number;
  s: number;
  t1Start: Rgb;
}

function derive(t: CustomTheme): Derived {
  const dark = t.base === 'dark';
  const stops = t.colors.map(hexToRgb);
  const byLum = [...stops].sort((a, b) => luminance(a) - luminance(b));
  const [h, s] = hueSatLight(dark ? byLum[0]! : byLum[byLum.length - 1]!);
  const base = hsl(h, s, BASE_LIGHTNESS[t.base]);
  // White or black: text at its extreme, which the veil must leave readable.
  const textExtreme: Rgb = dark ? [MAX_CHANNEL, MAX_CHANNEL, MAX_CHANNEL] : [0, 0, 0];
  const t1Start = hsl(h, Math.min(s, TEXT_SATURATION_MAX), TEXT_LIGHTNESS[t.base].t1);
  // Opaque surfaces: the base veiling the stops' average, lifted toward text level by level. Panels and chrome: a
  // surface veiling the gradient. Light text's worst point is the brightest, always a stop (convexity); dark text's is
  // the darkest, which can fall between stops.
  const layers = (veilPct: number): Layers => {
    const ground = mix(average(stops), base, veilPct);
    const surfaces = SURFACE_LIFT.map((lift) => mix(ground, t1Start, lift));
    const veiled = [surfaces[0]!, surfaces[3]!].flatMap((c) => [
      ...stops.map((stop) => mix(stop, c, veilPct)),
      ...(dark ? [] : stops.slice(1).map((to, i) => darkestVeiledPoint(stops[i]!, to, c, veilPct))),
    ]);
    return { ground, surfaces, backgrounds: [...surfaces, ...veiled], baseMix: veilPct };
  };
  // The veil thickens past baseMix only as far as text at its extreme needs to read on every background.
  let layer = layers(t.baseMix);
  while (layer.baseMix < FULL && layer.backgrounds.some((bg) => contrast(textExtreme, bg) < AA_TARGET)) layer = layers(Math.min(FULL, layer.baseMix + PUSH_STEP));
  return { ...layer, h, s, t1Start };
}

/** Every colour text can sit on in a custom theme, for checking colours drawn over it (the owner's panel colours). */
export const customBackgrounds = (t: CustomTheme): Rgb[] => derive(t).backgrounds;

/**
 * Every token a custom theme sets, as `--cp-*` name to value, for inline style on the themed element. `inherited`: the
 * base theme's INHERITED_FOREGROUNDS values (hex); each is pushed until it reads on the derived backgrounds.
 */
export function customThemeTokens(t: CustomTheme, inherited: Partial<Record<string, string>> = {}): Record<string, string> {
  const { ground, surfaces, backgrounds, baseMix, h, s, t1Start } = derive(t);
  const textSat = Math.min(s, TEXT_SATURATION_MAX);
  const textStart = TEXT_LIGHTNESS[t.base];
  const t1 = readable(t1Start, backgrounds);
  const t2 = readable(hsl(h, textSat, textStart.t2), backgrounds);
  const muted = readable(hsl(h, textSat, textStart.muted), backgrounds);
  // Accent: the most saturated stop, pushed until readable on every background; text on it is surface-1, so that pair holds too.
  const vivid = [...t.colors.map(hexToRgb)].sort((a, b) => hueSatLight(b)[1] - hueSatLight(a)[1])[0]!;
  const accent = readable(vivid, backgrounds);
  const hex = rgbToHex;
  const veil = (c: Rgb): string => `color-mix(in srgb, ${hex(c)} ${baseMix}%, transparent)`;
  const foregrounds = Object.entries(inherited).flatMap(([token, v]) => (v && HEX.test(v) ? [[token, hex(readable(hexToRgb(v), backgrounds))]] : []));

  return {
    '--cp-ground': hex(ground),
    '--cp-ground-paint': gradientPaint(t),
    // The body, which covers the root's paint: the gradient again, so chrome veils it rather than a flat surface.
    '--cp-body-paint': gradientPaint(t),
    '--cp-chrome-paint': veil(surfaces[0]!),
    '--cp-panel-paint': veil(surfaces[3]!),
    // A detached panel's window: the panel paint, as in a layout slot.
    '--cp-window-paint': veil(surfaces[3]!),
    ...Object.fromEntries(surfaces.map((c, i) => [`--cp-surface-${i}`, hex(c)])),
    '--cp-surface-cited': hex(mix(surfaces[2]!, accent, CITED_ACCENT_SHARE)),
    '--cp-border-faint': hex(mix(surfaces[1]!, t1, BORDER_LIFT.faint)),
    '--cp-border-subtle': hex(mix(surfaces[1]!, t1, BORDER_LIFT.subtle)),
    '--cp-border': hex(mix(surfaces[1]!, t1, BORDER_LIFT.normal)),
    '--cp-border-strong': hex(mix(surfaces[1]!, t1, BORDER_LIFT.strong)),
    '--cp-text-1': hex(t1),
    '--cp-text-2': hex(t2),
    '--cp-text-muted': hex(muted),
    '--cp-accent': hex(accent),
    '--cp-accent-hover': hex(mix(accent, t1, ACCENT_HOVER_SHARE)),
    '--cp-text-on-accent': hex(surfaces[1]!),
    ...Object.fromEntries(foregrounds),
  };
}

/** Every token name a custom theme can set, so wearing another theme clears them all. */
const CUSTOM_TOKEN_NAMES = [...Object.keys(customThemeTokens(DEFAULT_CUSTOM_THEME)), ...INHERITED_FOREGROUNDS];

/** What wearing a theme touches on an element: its inline style (typed structurally; tests type-check without the DOM). */
interface Styled {
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): unknown };
}

/**
 * Sets a custom theme's tokens inline on `el` (over its data-theme's), or clears them for null. `tokenOf` reads a token
 * as `el` now resolves it; it runs after the clear, so INHERITED_FOREGROUNDS come from the base theme.
 */
export function wearCustomTheme(el: Styled, t: CustomTheme | null, tokenOf: (token: string) => string): void {
  for (const name of CUSTOM_TOKEN_NAMES) el.style.removeProperty(name);
  if (!t) return;
  const inherited = Object.fromEntries(INHERITED_FOREGROUNDS.map((token) => [token, tokenOf(token)]));
  for (const [name, value] of Object.entries(customThemeTokens(t, inherited))) el.style.setProperty(name, value);
}
