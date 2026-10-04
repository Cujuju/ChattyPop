import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Renderer stores run at import (signals, resources): an import cycle reads a store before it exists and blanks the app. */
const STATE_DIR = join(import.meta.dirname, '../src/renderer/src/state');

function edges(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of readdirSync(STATE_DIR).filter((n) => n.endsWith('.ts'))) {
    const src = readFileSync(join(STATE_DIR, f), 'utf8');
    // Value imports only: `import type` is erased and can't cycle at run time.
    const deps = [...src.matchAll(/^import (?!type )[^;]*? from '(?:\.\/|@\/state\/)([\w-]+)';/gm)].map((m) => `${m[1]}.ts`);
    out.set(f, deps);
  }
  return out;
}

describe('renderer stores', () => {
  it('import each other without cycles', () => {
    const graph = edges();
    const cycles: string[] = [];
    const visit = (node: string, path: string[]): void => {
      if (path.includes(node)) {
        cycles.push([...path.slice(path.indexOf(node)), node].join(' → '));
        return;
      }
      for (const next of graph.get(node) ?? []) visit(next, [...path, node]);
    };
    for (const node of graph.keys()) visit(node, []);
    expect(cycles).toEqual([]);
  });
});
