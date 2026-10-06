// With INSTALLED_ENV set before registry imports, accepted installed plugins follow bundled entries. Core and main load their sides; refusals appear in the plugin list.
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { INSTALLED_ENV, type InstalledStart } from '@shared/installedPlugins';
import type { PluginDescriptor } from '@shared/bundledTypes';
import { host, installedRoot, sharedModule, writePlugin } from './installedFixtures';

vi.mock('electron', () => ({ app: { getPath: () => '' }, dialog: {}, ipcMain: { handle: () => undefined } }));

const zetaShared = sharedModule('zeta', "channels: defineChannels()({ core: { ping: ['renderer'] } })");
const zetaCore = `import plugin from './shared.js';\nexport default ${host('@plugin-sdk/core')}.defineCorePlugin(plugin, (ctx) => ctx.channels.serve({ ping: () => 'pong' }));\n`;
const zetaMain = `import plugin from './shared.js';\nexport default ${host('@plugin-sdk/main')}.defineMainPlugin(plugin, () => undefined);\n`;
const zetaImports = { '@plugin-sdk/shared': ['definePlugin', 'defineChannels'], '@plugin-sdk/core': ['defineCorePlugin'], '@plugin-sdk/main': ['defineMainPlugin'] };

let root: string;
let start: InstalledStart;
let registry: typeof import('@shared/bundledPlugins');
let core: typeof import('virtual:bundled-plugins/core');
let main: typeof import('virtual:bundled-plugins/main');

beforeAll(async () => {
  root = installedRoot();
  writePlugin(root, 'zeta', { manifest: { hostImports: zetaImports }, shared: zetaShared, core: zetaCore, main: zetaMain });
  writePlugin(root, 'broken', { core: "throw new Error('broken core');" });
  writePlugin(root, 'refused', { manifest: { sdk: '3.0.0' } });
  const { prepareInstalled } = await import('../src/main/plugins/installed/boot');
  const { encodeInstalledStart } = await import('../src/main/plugins/installed/runtime');
  const { readInstalledPlugin } = await import('../src/main/plugins/installed/read');
  start = prepareInstalled(root, () => undefined);
  // Accepted by main, but here the anchor's shared module throws: the plugin placed after its panel keeps loading.
  const panel = (id: string, after?: string): string => `panels: [{ id: '${id}', title: 'P', importance: 'reference', dialog: false, iconPath: ''${after ? `, after: '${after}'` : ''} }]`;
  writePlugin(root, 'anchor', { shared: "throw new Error('anchor shared');" });
  writePlugin(root, 'dependent', { shared: sharedModule('dependent', panel('dependent-panel', 'anchor-panel')) });
  const hereOnly = ['anchor', 'dependent'].map((id) => readInstalledPlugin(join(root, id)));
  const accepted = [...start.accepted, ...hereOnly].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  process.env[INSTALLED_ENV] = encodeInstalledStart(root, { ...start, accepted });
  try {
    registry = await import('@shared/bundledPlugins');
    core = await import('virtual:bundled-plugins/core');
    main = await import('virtual:bundled-plugins/main');
  } finally {
    // The worker runs other test files next; their registries must see no installed plugins.
    delete process.env[INSTALLED_ENV];
  }
});

describe('installed plugins in the registries', () => {
  it('lists the accepted descriptors after the build, once, the same instances the start loaded', () => {
    const ids = registry.BUNDLED_PLUGINS.map((p) => p.manifest.id);
    expect(ids.slice(-3)).toEqual(['broken', 'dependent', 'zeta']);
    expect(ids).not.toContain('refused');
    const zeta = registry.bundledPlugin('zeta');
    expect(core.default.find((e) => e.plugin.manifest.id === 'zeta')?.plugin).toBe(zeta);
    expect(main.default.find((e) => e.plugin.manifest.id === 'zeta')?.plugin).toBe(zeta);
  });

  it('publishes each process tier before loading sides; a side that throws is left out and reported', async () => {
    const { hostModules } = await import('@shared/hostModules');
    expect(hostModules()['@plugin-sdk/core']).toBe(await import('@plugin-sdk/core'));
    expect(hostModules()['@plugin-sdk/main']).toBe(await import('@plugin-sdk/main'));
    expect(core.failed).toEqual([{ id: 'anchor', error: 'anchor shared' }, { id: 'broken', error: 'broken core' }]);
    expect(main.failed.map((f) => f.id)).toEqual(['anchor']);
  });

  it("keeps a plugin whose anchor failed in this process, rather than failing the registry's load", () => {
    const ids = registry.BUNDLED_PLUGINS.map((p) => p.manifest.id);
    expect(ids).not.toContain('anchor');
    expect(ids).toContain('dependent');
  });
});

describe("core's plugin host with installed plugins", () => {
  it('activates an accepted core side and lists every plugin with where it comes from; refused and failed ones with why', async () => {
    const [{ PluginHost }, { RuleKinds }, { ProviderRegistry }, { setSetting }, { tempDb, tempDir }] = await Promise.all([
      import('../src/core/plugins/host'),
      import('../src/core/rules/kinds'),
      import('../src/core/ai/registry'),
      import('../src/core/db'),
      import('./helpers'),
    ]);
    const db = tempDb();
    const plain: PluginDescriptor = { manifest: { id: 'plain', name: 'Plain', version: '1', description: '' } };
    const installed = ['broken', 'zeta'].map((id) => registry.bundledPlugin(id)!);
    const host = new PluginHost(
      tempDir(),
      {
        db,
        emit: () => undefined,
        changed: () => undefined,
        ai: async () => ({ text: '' }),
        decider: () => null,
        bundled: {
          rules: new RuleKinds(),
          ready: () => db,
          archive: () => null as never,
          mediaDir: tempDir(),
          attachmentsDir: tempDir(),
          pluginData: { root: tempDir(), unmoved: {} },
          storeText: () => undefined,
          catchUp: () => undefined,
          storeLinkText: () => undefined,
          storeLinkImages: () => undefined,
          saveSetting: (key, value) => setSetting(db, key, value),
          aiSettings: () => null as never,
          providers: new ProviderRegistry(() => undefined),
          decider: () => null,
          now: Date.now,
        },
      },
      core.default.filter((e) => e.plugin.manifest.id === 'zeta'),
      [plain, ...installed],
      { start, failed: core.failed },
    );
    await host.loadAll();
    expect(host.list()).toMatchObject([
      { id: 'plain', origin: 'bundled', bundled: true, status: 'active', dir: '' },
      { id: 'broken', origin: 'installed', bundled: true, status: 'error', error: 'broken core', dir: join(root, 'broken') },
      { id: 'zeta', origin: 'installed', bundled: true, status: 'active', dir: join(root, 'zeta') },
      { id: 'refused', origin: 'installed', bundled: true, status: 'error', error: expect.stringMatching(/SDK/) },
    ]);
    await expect(host.call('renderer', 'zeta', 'ping', [])).resolves.toBe('pong');
    // A refused plugin's switch is kept for a start that loads it; nothing reloads.
    await host.setEnabled('refused', false);
    expect(host.list().find((p) => p.id === 'refused')).toMatchObject({ status: 'error' });
    await host.reload();
    expect(host.list().map((p) => p.id)).toEqual(['plain', 'broken', 'zeta', 'refused']);
  });
});
