// Release stamping (scripts/pluginScan/manifest.ts, docs/plugin-architecture.md §16): the definePlugin manifest's
// version literal is found through syntax and replaced in place, in both shapes plugins use; anything else is refused,
// and plugin:check's scan refuses it too.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { manifestVersion, stampVersion } from '../scripts/pluginScan/manifest';

/** A copy of every public plugin's shared/index.ts as it was when stamping came: both manifest shapes, inline and a const. */
const MANIFESTS = join(import.meta.dirname, 'fixtures/manifests');
const REL = 'shared/index.ts';
const stamp = (text: string, version = '9.8.7'): string => stampVersion(text, version, REL);
const versionOf = (text: string): string => manifestVersion({ rel: REL, text }).version;

const INLINE = `import { definePlugin } from '@plugin-sdk/shared';
export const plugin = definePlugin({
  // version: '0.0.1' in a comment is not it.
  manifest: { id: 'probe', name: 'Probe', version: "1.2.3", description: 'version: \\'1.0.0\\'' },
  other: { version: '5.5.5' },
});
export default plugin;
`;
const SHORTHAND = `import { definePlugin } from '@plugin-sdk/shared';
export const manifest = {
  id: 'probe',
  name: 'Probe',
  version: '1.2.3',
} as const;
const unrelated = { version: '7.7.7' };
export const plugin = definePlugin({ manifest });
export default plugin;
`;
const NAMED = SHORTHAND.replace('export const manifest =', 'const m =').replace('{ manifest }', '{ manifest: m }');

describe('stamping a manifest version', () => {
  it.each([['inline', INLINE], ['a same-file const, shorthand', SHORTHAND], ['a same-file const, named', NAMED]])('replaces only the manifest literal: %s', (_, text) => {
    const at = manifestVersion({ rel: REL, text });
    expect(at).toMatchObject({ id: 'probe', version: '1.2.3' });
    const stamped = stamp(text);
    expect(versionOf(stamped)).toBe('9.8.7');
    // Every other byte, its quotes included, is kept.
    expect(stamped).toBe(`${text.slice(0, at.start + 1)}9.8.7${text.slice(at.end - 1)}`);
  });

  it.each([
    ['an imported manifest', "import { definePlugin } from '@plugin-sdk/shared';\nimport { manifest } from './manifest';\nexport default definePlugin({ manifest });\n", /imported/],
    ['a computed manifest', "import { definePlugin } from '@plugin-sdk/shared';\nexport default definePlugin({ manifest: make() });\n", /object literal or a const/],
    ['a let manifest', "import { definePlugin } from '@plugin-sdk/shared';\nlet m = { id: 'p', version: '1.0.0' };\nexport default definePlugin({ manifest: m });\n", /const object literal/],
    ['a non-literal version', "import { definePlugin } from '@plugin-sdk/shared';\nconst V = '1.0.0';\nexport default definePlugin({ manifest: { id: 'p', version: V } });\n", /`version` must be a string literal/],
    ['a template version', "import { definePlugin } from '@plugin-sdk/shared';\nexport default definePlugin({ manifest: { id: 'p', version: `1.0.0` } });\n", /`version` must be a string literal/],
    ['a spread manifest', "import { definePlugin } from '@plugin-sdk/shared';\nexport default definePlugin({ manifest: { ...base, id: 'p', version: '1.0.0' } });\n", /spreads/],
    ['two versions', "import { definePlugin } from '@plugin-sdk/shared';\nexport default definePlugin({ manifest: { id: 'p', version: '1.0.0', 'version': '2.0.0' } });\n", /exactly one `version`/],
    ['two definePlugin calls', `${INLINE}export const again = definePlugin({ manifest: { id: 'q', version: '1.0.0' } });\n`, /found 2 definePlugin calls/],
    ['no definePlugin call', 'export const plugin = {};\n', /found 0 definePlugin calls/],
    ['a manifest const inside a function', "import { definePlugin } from '@plugin-sdk/shared';\nfunction make() {\n  const m = { id: 'p', version: '1.0.0' };\n  return definePlugin({ manifest: m });\n}\nexport default make();\n", /one top-level const/],
  ])('refuses %s', (_, text, why) => {
    expect(() => stamp(text)).toThrow(why);
  });

  it('stamps every public plugin as its shared/index.ts stands, the rest byte for byte', () => {
    const files = readdirSync(MANIFESTS);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(join(MANIFESTS, file), 'utf8');
      const at = manifestVersion({ rel: REL, text });
      expect(at.id, file).toBe(file.replace(/\.ts$/, ''));
      const stamped = stamp(text, '10.20.30');
      expect(versionOf(stamped), file).toBe('10.20.30');
      expect(stamped, file).toBe(`${text.slice(0, at.start + 1)}10.20.30${text.slice(at.end - 1)}`);
    }
  });
});
