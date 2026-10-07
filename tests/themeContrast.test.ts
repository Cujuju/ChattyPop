import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILT_IN_THEME_IDS, DEFAULT_APPEARANCE_SETTINGS } from '../src/shared/settings';

// Readability held as a contract: each theme's text and badge pairs meet WCAG 2.x AA for body text.
const THEME_DIR = resolve(__dirname, '../src/renderer/src/theme');
/** WCAG 2.x AA for normal-size text. */
const AA_TEXT = 4.5;

/** `--cp-x: value;` declarations of the block opened by `selector {`, e.g. a theme's main block. */
function declarations(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return new Map();
  const body = css.slice(start, css.indexOf('\n}', start));
  return new Map([...body.matchAll(/(--cp-[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

/** A theme's tokens: the defaults with its own block over them, `var()` chains followed to a hex colour. */
function palette(id: string): (token: string) => string {
  const defaults = declarations(readFileSync(resolve(THEME_DIR, 'tokens.css'), 'utf8'), "[data-theme='night']");
  const own = id === DEFAULT_APPEARANCE_SETTINGS.theme ? new Map() : declarations(readFileSync(resolve(THEME_DIR, `themes/${id}.css`), 'utf8'), `[data-theme='${id}']`);
  const merged = new Map([...defaults, ...own]);
  const hex = (token: string): string => {
    const v = merged.get(token) ?? '';
    const ref = /^var\((--cp-[\w-]+)\)$/.exec(v);
    if (ref) return hex(ref[1]!);
    if (!/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`${id}: ${token} is not a hex colour (${v})`);
    return v;
  };
  return hex;
}

const luminance = (hex: string): number =>
  [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0);
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

const SURFACES = [0, 1, 2, 3, 4, 5].map((n) => `--cp-surface-${n}`);
const SECTIONS = ['summary', 'provider', 'alerts', 'links', 'chat', 'plans', 'tags', 'rules'].map((s) => `--cp-section-${s}`);
/** Every colour Shiki's css-variables theme paints code in (ui/highlight.ts), read on the code ground. */
const CODE_COLORS = [
  'foreground',
  ...['keyword', 'string', 'string-expression', 'constant', 'function', 'parameter', 'punctuation', 'comment', 'link', 'inserted', 'deleted', 'changed'].map((t) => `token-${t}`),
  ...['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'].flatMap((c) => [`ansi-${c}`, `ansi-bright-${c}`]),
].map((c) => `--cp-code-${c}`);
/** [foreground, background] pairs every theme must keep readable. */
const PAIRS: [string, string][] = [
  ...['--cp-text-1', '--cp-text-2', '--cp-text-muted'].flatMap((t) => SURFACES.map((s): [string, string] => [t, s])),
  ['--cp-text-on-accent', '--cp-accent'],
  ['--cp-info', '--cp-cite-bg'],
  ['--cp-danger', '--cp-danger-bg'],
  ['--cp-success', '--cp-success-bg'],
  ...SECTIONS.flatMap((s): [string, string][] => [
    [s, '--cp-surface-3'],
    ['--cp-text-on-accent', s],
  ]),
  ...CODE_COLORS.map((c): [string, string] => [c, '--cp-code-background']),
];

describe('theme contrast', () => {
  for (const id of BUILT_IN_THEME_IDS) {
    it(`${id}: every text and badge pair meets AA`, () => {
      const hex = palette(id);
      const failing = PAIRS.map(([fg, bg]) => ({ fg, bg, ratio: contrast(hex(fg), hex(bg)) })).filter((p) => p.ratio < AA_TEXT);
      expect(failing).toEqual([]);
    });
  }
});
