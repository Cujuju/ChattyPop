import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { userSelectViolations } from '../scripts/pluginScan/rules';
import { PLUGINS_DIR } from './rendererGraph';

// Requires Safari’s -webkit-user-select prefix; plugin scanning applies the same rule.
/** Host styles and fixture plugin folders; the app holds no plugins. */
const CSS_DIRS = [resolve(__dirname, '../src/renderer/src'), PLUGINS_DIR];

const cssFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? cssFiles(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : []));

describe('Safari prefixes', () => {
  it('every user-select has a -webkit-user-select of the same value beside it', () => {
    const files = CSS_DIRS.flatMap(cssFiles);
    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap((file) => userSelectViolations({ rel: file, text: readFileSync(file, 'utf8') }))).toEqual([]);
  });

  it('names a user-select without its prefix, or with another value, by line', () => {
    const text = '.a {\n  color: red;\n  user-select: none;\n}\n.b { user-select: text; -webkit-user-select: none; }\n.c { user-select: all; -webkit-user-select: all; }\n';
    expect(userSelectViolations({ rel: 'x.css', text })).toEqual([
      'x.css:3: user-select: none needs -webkit-user-select: none beside it',
      'x.css:5: user-select: text needs -webkit-user-select: text beside it',
    ]);
  });
});
