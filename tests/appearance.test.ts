import { readFileSync } from 'node:fs';
import { panelIdentity } from '../src/renderer/src/panels/titles';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILT_IN_THEME_IDS, DEFAULT_APPEARANCE_SETTINGS, DEFAULT_CUSTOM_THEME, builtInTheme, normalizeAppearanceSettings, normalizeCustomTheme } from '../src/shared/settings';

const THEME_DIR = resolve(__dirname, '../src/renderer/src/theme');
const read = (rel: string): string => readFileSync(resolve(THEME_DIR, rel), 'utf8');

describe('appearance settings', () => {
  it('normalizes anything to a known theme, defaulting to night', () => {
    expect(normalizeAppearanceSettings(undefined)).toEqual(DEFAULT_APPEARANCE_SETTINGS);
    expect(normalizeAppearanceSettings({ theme: 'sepia' })).toEqual(DEFAULT_APPEARANCE_SETTINGS);
    expect(normalizeAppearanceSettings({ theme: 'tide', extra: 1 })).toEqual({ theme: 'tide', custom: DEFAULT_CUSTOM_THEME, panelColors: {}, savedColors: [] });
  });

  it('every theme id is styled: night by tokens.css, the rest by an imported themes/<id>.css', () => {
    expect(read('tokens.css')).toContain(`[data-theme='${DEFAULT_APPEARANCE_SETTINGS.theme}']`);
    const index = read('index.css');
    for (const id of BUILT_IN_THEME_IDS.filter((t) => t !== DEFAULT_APPEARANCE_SETTINGS.theme)) {
      expect(index).toContain(`@import './themes/${id}.css';`);
      expect(read(`themes/${id}.css`)).toContain(`[data-theme='${id}'] {`);
    }
  });

  it('a custom theme keeps valid stops, clamps its numbers and wears its base theme', () => {
    const custom = normalizeCustomTheme({ colors: ['#1A0425', 'red', '#a418b9'], angle: 400, baseMix: -5, base: 'light' });
    expect(custom).toEqual({ colors: ['#1a0425', '#a418b9'], angle: 359, baseMix: 0, base: 'light' });
    expect(normalizeCustomTheme({ colors: ['#ffffff'] }).colors).toEqual(DEFAULT_CUSTOM_THEME.colors);
    expect(builtInTheme({ theme: 'custom', custom })).toBe('daylight');
    expect(builtInTheme({ theme: 'tide', custom })).toBe('tide');
  });

  it('a panel carries its own id as its colour key, so plugin panels sharing a section colour one by one', () => {
    expect(panelIdentity('plugin:acme:feed')).toEqual({ 'data-section': 'plugin', 'data-panel-color': 'plugin:acme:feed' });
    expect(panelIdentity('summary')).toEqual({ 'data-section': 'summary', 'data-panel-color': 'summary' });
  });
});
