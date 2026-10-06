// Virtual logs use @cujuju/solidjs-virtual-log and preserve scroll offsets during gestures.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });

describe('virtual log engine', () => {
  it('TanStack Virtual is neither a dependency nor imported', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies?: object; devDependencies?: object };
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => d.startsWith('@tanstack/'))).toEqual([]);
    expect(files('src').filter((f) => readFileSync(f, 'utf8').includes('@tanstack/'))).toEqual([]);
  });

});
