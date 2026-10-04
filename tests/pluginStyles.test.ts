// Plugin styling split (docs/plugin-architecture.md §14): the theme owns how things look; a plugin's CSS lays out its
// own elements with tokens, and the look vocabulary sets look only, so the two never set the same property.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { declarations, isCustomProperty, isLook, lookCustomProperties, pluginViolation, where, type Declaration } from '@main/pluginBuild/cssRules';
import { PLUGINS_DIR } from './rendererGraph';

const ROOT = resolve(__dirname, '..');
/**
 * Fixture plugin folders (renderer modules and a page): the app holds no plugins. `pnpm plugin:check` runs the same
 * check (checkStyles) on each plugin's own folder.
 */
/** The host's styles: the theme, its look vocabulary and host modules. */
const RENDERER_DIR = resolve(ROOT, 'src/renderer/src');
const LOOK_DIR = resolve(RENDERER_DIR, 'theme/look');

const cssFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? cssFiles(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : []));

const read = (files: string[]): Declaration[] => files.flatMap((f) => declarations(relative(ROOT, f), readFileSync(f, 'utf8')));

const pluginDecls = read(cssFiles(PLUGINS_DIR));
const lookFiles = cssFiles(LOOK_DIR);
const allDecls = [...read(cssFiles(RENDERER_DIR)), ...pluginDecls];

describe('plugin CSS holds structure only', () => {
  it('finds the stylesheets it checks', () => {
    expect(pluginDecls.length).toBeGreaterThan(0);
    expect(lookFiles.length).toBeGreaterThan(0);
  });

  it('every plugin declaration is a structural property with a token, keyword, zero, count or proportion value', () => {
    const lookTokens = lookCustomProperties(allDecls);
    const bad = pluginDecls.flatMap((d) => {
      const why = pluginViolation(d, lookTokens);
      return why ? [`${where(d)}: ${why}`] : [];
    });
    expect(bad).toEqual([]);
  });

  it('flags look properties, literals and look tokens in a plugin stylesheet', () => {
    const sample = declarations(
      'sample.module.css',
      `.a { color: var(--cp-text-1); width: 12px; transform: rotate(var(--cp-pull-wind)); translate: 0 var(--x); display: grid; }
       .b { --cp-text-1: var(--cp-danger); --lane: var(--cp-space-2); height: var(--lane); border: 0; grid-row: span 3; }`,
    );
    const lookTokens = lookCustomProperties([...sample, ...declarations('theme.css', ':root { --cp-text-1: #fff; } .c { color: var(--cp-text-1); }')]);
    expect(sample.map((d) => [d.property, pluginViolation(d, lookTokens)])).toEqual([
      ['color', 'look property (the theme owns it)'],
      ['width', 'literal 12px'],
      ['transform', 'look property (the theme owns it)'],
      ['translate', null],
      ['display', null],
      ['--cp-text-1', 'sets a custom property a look declaration reads'],
      ['--lane', null],
      ['height', null],
      ['border', 'look property (the theme owns it)'],
      ['grid-row', null],
    ]);
  });
});

describe('look vocabulary', () => {
  const lookDecls = read(lookFiles);

  it('sets look only, so no plugin structural rule competes with it', () => {
    const bad = lookDecls.filter((d) => !isCustomProperty(d.property) && !isLook(d)).map(where);
    expect(bad).toEqual([]);
  });

  it('names each role once across its files (the SDK merges them into one map)', () => {
    const roles = lookFiles.flatMap((f) => [
      ...new Set([...readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-z][\w-]*)/gi)].map((m) => m[1]!)),
    ]);
    expect(roles.filter((r, i) => roles.indexOf(r) !== i)).toEqual([]);
  });
});
