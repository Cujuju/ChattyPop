// The startup splash wears the theme the main window last saved: only known tokens with colour-like values reach it.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SPLASH_THEME_TOKENS } from '@shared/splash.mjs';
import { normalizeSplashTheme, readSplashTheme, writeSplashTheme } from '../src/main/splashWindow.mjs';

vi.mock('electron', () => ({ BrowserWindow: class {} }));

const [surface, accent] = SPLASH_THEME_TOKENS.filter((t) => t === '--cp-surface-1' || t === '--cp-accent');
const file = (): string => join(mkdtempSync(join(tmpdir(), 'splash-theme-')), 'splash-theme.json');

describe('the splash theme', () => {
  it('keeps the known tokens with colour-like values', () => {
    expect(normalizeSplashTheme({ [surface!]: 'rgb(16, 19, 26)', [accent!]: 'oklch(70% 0.1 250 / 50%)', '--cp-other': '#fff' })).toEqual({
      [surface!]: 'rgb(16, 19, 26)',
      [accent!]: 'oklch(70% 0.1 250 / 50%)',
    });
  });

  it.each([
    ['a url', 'url(https://example.com/x.png)'],
    ['a declaration break', 'red; background: blue'],
    ['a block', 'red } body {'],
    ['quotes', '"red"'],
    ['a value past any colour', '#'.repeat(201)],
  ])('drops %s', (_what, value) => {
    expect(normalizeSplashTheme({ [surface!]: value })).toBeNull();
  });

  it('reads nothing from a missing or unreadable file', () => {
    const f = file();
    expect(readSplashTheme(f)).toBeNull();
    writeFileSync(f, '{not json');
    expect(readSplashTheme(f)).toBeNull();
  });

  it('saves a valid theme and leaves the file alone for an invalid one', () => {
    const f = file();
    writeSplashTheme(f, { [surface!]: '#10131a' });
    expect(readSplashTheme(f)).toEqual({ [surface!]: '#10131a' });
    writeSplashTheme(f, { [surface!]: 'url(x)' });
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ [surface!]: '#10131a' });
  });

  it('lists only tokens the splash stylesheet wears', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../src/renderer/src/theme/splash.css'), 'utf8');
    expect(SPLASH_THEME_TOKENS.filter((t) => !css.includes(`var(${t})`))).toEqual([]);
  });
});
