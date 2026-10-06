// Renderer SDK tiers cannot load registries or plugins. Contracts depend only on @/api; plugin scanning enforces SDK tier imports.
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLUGINS_DIR, ROOT, closure } from './rendererGraph';

const SDK_DIR = join(ROOT, 'src/plugin-sdk/renderer');
const CONTRACT = join(SDK_DIR, 'index.ts');
const TIERS = { contract: CONTRACT, kit: join(SDK_DIR, 'kit/index.ts'), posting: join(SDK_DIR, 'posting/index.ts'), shell: join(SDK_DIR, 'shell/index.ts') };
const HOST_DIR = join(ROOT, 'src/renderer/src');
/** The renderer API leaf: the one host module the contract loads (it queues calls until a transport installs). */
const API_LEAF = join(HOST_DIR, 'api.ts');
/** Installed shared-registry loader completes declarations and publishes the shared SDK tier. */
const SHARED_LOADER = join(HOST_DIR, 'plugins/installedShared.ts');
const SHARED_LOADER_OWN = [SHARED_LOADER, join(HOST_DIR, 'plugins/installedLoader.ts'), join(ROOT, 'src/plugin-sdk/shared/index.ts')];
/** What only page entries load: the registry, and the entries themselves. */
const ENTRY_ONLY = [join(HOST_DIR, 'plugins/bundled.ts'), join(HOST_DIR, 'plugins/page.ts'), join(HOST_DIR, 'main.tsx')];

const rel = (file: string): string => relative(ROOT, file).replaceAll('\\', '/');
const under = (dir: string) => (file: string): boolean => !relative(dir, file).startsWith('..');

describe('renderer SDK boundary', () => {
  it.each(Object.entries(TIERS))('%s never loads the plugin registry, a page entry or a plugin, however indirectly', (_tier, entry) => {
    const loaded = [...closure([entry])];
    expect(loaded.filter((f) => ENTRY_ONLY.includes(f) || under(PLUGINS_DIR)(f)).map(rel)).toEqual([]);
  });

  it('the contract loads only itself, shared code and the @/api leaf: no host store, view or kit', () => {
    const loaded = [...closure([CONTRACT])];
    const own = (f: string): boolean => under(SDK_DIR)(f) && !under(join(SDK_DIR, 'kit'))(f) && !under(join(SDK_DIR, 'posting'))(f) && !under(join(SDK_DIR, 'shell'))(f);
    expect(loaded.filter((f) => !own(f) && !under(join(ROOT, 'src/shared'))(f) && f !== API_LEAF && !SHARED_LOADER_OWN.includes(f)).map(rel)).toEqual([]);
    expect(loaded.filter(under(join(HOST_DIR, 'state'))).map(rel)).toEqual([]);
  });

  it('the shared registry’s installed-plugin loader loads no renderer tier, host store or registry: they read the shared registry it completes', () => {
    const loaded = [...closure([SHARED_LOADER])];
    expect(loaded.filter((f) => !SHARED_LOADER_OWN.includes(f) && !under(join(ROOT, 'src/shared'))(f) && f !== API_LEAF).map(rel)).toEqual([]);
    expect(loaded.map(rel)).not.toContain('src/shared/bundledPlugins.ts');
  });
});
