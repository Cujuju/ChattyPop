// sRGB colour math for derived theme colours: mixing as CSS color-mix(in srgb) does, WCAG contrast, and pushing a
// colour's lightness until it reads on given backgrounds.

/** WCAG 2.x AA for normal-size text, as tests/themeContrast.test.ts holds the built-in themes to. */
export const AA_TEXT = 4.5;
export type Rgb = readonly [number, number, number];

/** One contrast-push step, in percent lightness. */
export const PUSH_STEP = 2;
export const FULL = 100;
export const MAX_CHANNEL = 255;

export const hexToRgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as unknown as Rgb;
export const rgbToHex = (c: Rgb): string => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
/** `b` at `pct` percent over `a`, in sRGB as CSS color-mix(in srgb) mixes; rounded to 8-bit, so contrast is checked on the colour emitted. */
export const mix = (a: Rgb, b: Rgb, pct: number): Rgb => a.map((v, i) => Math.round(v + (b[i]! - v) * (pct / FULL))) as unknown as Rgb;
export const average = (cs: Rgb[]): Rgb => [0, 1, 2].map((i) => cs.reduce((s, c) => s + c[i]!, 0) / cs.length) as unknown as Rgb;

export function luminance(c: Rgb): number {
  const lin = c.map((v) => v / MAX_CHANNEL).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Hue (degrees), saturation and lightness (percent) of an sRGB colour. */
export function hueSatLight(c: Rgb): [number, number, number] {
  const [r, g, b] = c.map((v) => v / MAX_CHANNEL) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return [0, 0, l * FULL];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s * FULL, l * FULL];
}
export function hsl(h: number, s: number, l: number): Rgb {
  const sat = s / FULL;
  const lig = l / FULL;
  const k = (n: number): number => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  return [0, 8, 4].map((n) => Math.round((lig - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))) * MAX_CHANNEL)) as unknown as Rgb;
}

const WHITE: Rgb = [MAX_CHANNEL, MAX_CHANNEL, MAX_CHANNEL];
const BLACK: Rgb = [0, 0, 0];
/** Headroom over AA for the browser's 8-bit compositing of veils, which can land each channel half a step off our maths. */
const CONTRAST_ROUNDING_MARGIN = 0.05;
/** The ratio derived colours are pushed to: AA plus rounding headroom. */
export const AA_TARGET = AA_TEXT + CONTRAST_ROUNDING_MARGIN;

/** `c`'s weakest contrast against the colours in `on`. */
export const minContrast = (c: Rgb, on: Rgb[]): number => Math.min(...on.map((bg) => contrast(c, bg)));

/** Preserves hue while adjusting lightness toward best contrasting extremes until AA_TARGET is met on all backgrounds; otherwise returns best measured contrast. */
export function readable(c: Rgb, on: Rgb[]): Rgb {
  const [h, s, l] = hueSatLight(c);
  const lightenFirst = minContrast(WHITE, on) >= minContrast(BLACK, on);
  let best = c;
  let bestRatio = minContrast(c, on);
  for (const lighten of [lightenFirst, !lightenFirst]) {
    for (let step = 0; step <= FULL; step += PUSH_STEP) {
      const lig = lighten ? Math.min(FULL, l + step) : Math.max(0, l - step);
      const t = hsl(h, s, lig);
      const ratio = minContrast(t, on);
      if (ratio >= AA_TARGET) return t;
      if (ratio > bestRatio) [best, bestRatio] = [t, ratio];
      if (lig === (lighten ? FULL : 0)) break;
    }
  }
  return best;
}

/** `hex` made readable against every colour in `on` (readable). */
export const readableOn = (hex: string, on: Rgb[]): string => rgbToHex(readable(hexToRgb(hex), on));
