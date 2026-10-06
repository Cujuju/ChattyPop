import { describe, expect, it } from 'vitest';
import { AA_TEXT, contrast, customThemeTokens } from '../src/renderer/src/theme/customTheme';
import { readableOn } from '../src/renderer/src/theme/color';
import { customThemeFromSettings } from '../src/main/discord/appearance';
import type { CustomTheme } from '../src/shared/settings';

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
/** `fg` at `pct` percent over `bg`, as color-mix(in srgb, fg pct%, transparent) composites over the gradient, to 8-bit as painted. */
const over = (fg: string, bg: string, pct: number): [number, number, number] => rgb(bg).map((b, i) => Math.round(b + (rgb(fg)[i]! - b) * (pct / 100))) as [number, number, number];
/** Points per segment the test samples: far denser than the derivation's own search needs. */
const SAMPLES = 256;
/** The gradient as painted: each segment between adjacent stops, finely sampled. */
const painted = (stops: string[]): string[] =>
  stops.slice(1).flatMap((to, i) =>
    Array.from({ length: SAMPLES + 1 }, (_, k) => `#${over(to, stops[i]!, (k / SAMPLES) * 100).map((c) => c.toString(16).padStart(2, '0')).join('')}`),
  );
const VEIL = /^color-mix\(in srgb, (#[0-9a-f]{6}) (\d+)%, transparent\)$/;

// Discord theme fixture plus contrast-challenging gradient stops.
const THEMES: [string, CustomTheme][] = [
  ['owner', { colors: ['#1a0425', '#a418b9', '#380933'], angle: 14, baseMix: 74, base: 'dark' }],
  ['bright stops, dark base, no veil', { colors: ['#ffff00', '#ffffff'], angle: 90, baseMix: 0, base: 'dark' }],
  ['dark stops, light base, no veil', { colors: ['#000000', '#101030'], angle: 0, baseMix: 0, base: 'light' }],
  ['mid grey both ways', { colors: ['#808080', '#777777', '#888888'], angle: 45, baseMix: 30, base: 'light' }],
  ['red to green dips darker mid-blend, light base', { colors: ['#ff0000', '#00ff00'], angle: 90, baseMix: 0, base: 'light' }],
  // Codex review counterexamples: a mid-blend dip and a rounding edge.
  ['mid-blend dip, light base', { colors: ['#a1133f', '#342587'], angle: 0, baseMix: 21, base: 'light' }],
  ['rounding edge', { colors: ['#d1c458', '#412345'], angle: 0, baseMix: 45, base: 'dark' }],
  ['rounding edge, light base', { colors: ['#d1c458', '#412345'], angle: 0, baseMix: 45, base: 'light' }],
];
/** Night's inherited foregrounds (tokens.css), which a custom theme must re-push onto its own surfaces. */
const NIGHT_FOREGROUNDS = {
  '--cp-section-summary': '#b79cff',
  '--cp-section-links': '#5cbcf5',
  '--cp-platform-youtube': '#f07a7a',
  '--cp-info': '#6cc7e6',
  '--cp-success': '#6fce8a',
  '--cp-danger': '#f0a0a0',
};

describe('custom gradient theme', () => {
  for (const [name, theme] of THEMES) {
    it(`${name}: text and accent meet AA on every surface and every veiled stop`, () => {
      const tok = customThemeTokens(theme, NIGHT_FOREGROUNDS);
      const veils = ['--cp-chrome-paint', '--cp-panel-paint'].map((k) => VEIL.exec(tok[k]!)!);
      const backgrounds = [
        ...[0, 1, 2, 3, 4, 5].map((n) => rgb(tok[`--cp-surface-${n}`]!)),
        ...veils.flatMap((v) => painted(theme.colors).map((point) => over(v[1]!, point, Number(v[2])))),
      ];
      const failing = ['--cp-text-1', '--cp-text-2', '--cp-text-muted', '--cp-accent', ...Object.keys(NIGHT_FOREGROUNDS)].flatMap((t) =>
        backgrounds.map((bg) => ({ t, ratio: contrast(rgb(tok[t]!), bg) })).filter((p) => p.ratio < AA_TEXT),
      );
      expect(failing).toEqual([]);
      expect(contrast(rgb(tok['--cp-text-on-accent']!), rgb(tok['--cp-accent']!))).toBeGreaterThanOrEqual(AA_TEXT);
    });
  }
});

/** Protobuf encoding helpers: just what the verified settings shape needs. */
const varint = (n: number): number[] => { const out: number[] = []; do { out.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0)); n >>>= 7; } while (n); return out; };
const field = (no: number, bytes: number[]): number[] => [...varint((no << 3) | 2), ...varint(bytes.length), ...bytes];
const num = (no: number, n: number): number[] => [...varint(no << 3), ...varint(n)];
const text = (s: string): number[] => [...Buffer.from(s, 'utf8')];

describe('Discord custom theme import', () => {
  it('reads colours, angle, base mix and base from PreloadedUserSettings.appearance', () => {
    const custom = [...field(1, text('#1a0425')), ...field(1, text('#a418b9')), ...field(1, text('#380933')), ...num(3, 14), ...num(4, 74)];
    const appearance = [...num(1, 1), ...num(2, 1), ...field(3, field(4, custom)), ...num(12, 2)];
    // An unrelated field first, as in the real message.
    const settings = Buffer.from([...field(5, num(1, 1)), ...field(13, appearance)]);
    expect(customThemeFromSettings(settings)).toEqual({ colors: ['#1a0425', '#a418b9', '#380933'], angle: 14, baseMix: 74, base: 'dark' });
  });

  it('rejects a field longer than the bytes left (Codex review)', () => {
    const colour = [...varint((1 << 3) | 2), ...varint(10), ...text('#ff0000')];
    expect(() => customThemeFromSettings(Buffer.from(field(13, field(3, field(4, colour)))))).toThrow(/Truncated/);
  });

  it('is null when Discord has no custom theme', () => {
    expect(customThemeFromSettings(Buffer.from(field(13, num(1, 1))))).toBeNull();
  });
});

describe('panel colours', () => {
  const night = [rgb('#141822'), rgb('#171c26'), rgb('#10131a')];
  const daylight = [rgb('#f4f6f9'), rgb('#ffffff')];
  it('a colour too close to the surfaces is pushed until it and text-on-accent on it meet AA', () => {
    const out = readableOn('#202840', night);
    for (const bg of night) expect(contrast(rgb(out), bg)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(rgb(readableOn('#ffe066', daylight)), daylight[1]!)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('the extremes push the right way: black on night lightens, white on daylight darkens (Codex review)', () => {
    for (const bg of night) expect(contrast(rgb(readableOn('#000000', night)), bg)).toBeGreaterThanOrEqual(AA_TEXT);
    for (const bg of daylight) expect(contrast(rgb(readableOn('#ffffff', daylight)), bg)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('mid-grey grounds take whichever direction reads, not a luminance cutoff', () => {
    const grey = [rgb('#767676')];
    expect(contrast(rgb(readableOn('#7a7a7a', grey)), grey[0]!)).toBeGreaterThanOrEqual(AA_TEXT);
  });
});
