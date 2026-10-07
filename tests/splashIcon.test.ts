import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
/** An SVG's content, without the classes the splash adds or formatting. */
const shapes = (svg: string): string =>
  svg
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>[\s\S]*$/, '')
    .replace(/ class="[^"]*"/g, '')
    .replace(/\s+/g, ' ')
    .replace(/> </g, '><')
    .trim();

describe('splash icon', () => {
  it('draws the app icon: same shapes as build/icon.svg', () => {
    const page = readFileSync(join(root, 'src/renderer/splash.html'), 'utf8');
    const icon = readFileSync(join(root, 'build/icon.svg'), 'utf8');
    expect(shapes(page.slice(page.indexOf('<svg class="splash-icon"')))).toBe(shapes(icon));
  });
});
