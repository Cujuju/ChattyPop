// Provider and panel fixture plugins in subset builds: builds pass checkBundled, declare their providers, and get
// default layouts showing the usage slot's panel (and Digest) only for built plugins.
import { describe, expect, it } from 'vitest';
import { providerDeclarations } from '@shared/aiProviders';
import { anchorCatalog, checkBundled } from '@shared/bundledCheck';
import { buildPresets } from '../src/renderer/src/layout/presets';
import { panelIds } from '../src/renderer/src/layout/tree';
import type { PluginDescriptor } from '@shared/bundledTypes';
import { DIGEST_PANEL, FIXTURE_PLUGINS, USAGE_PANEL, alpha, beta, digest, panelsOf, usage } from './p2Fixtures';

const build = (keep: (id: string) => boolean) => FIXTURE_PLUGINS.filter((p) => keep(p.manifest.id));
/** Each build, with the providers it declares in Settings → AI order. */
const BUILDS: Record<string, { plugins: readonly PluginDescriptor[]; providers: string[] }> = {
  all: { plugins: build(() => true), providers: ['p2alpha', 'p2beta', 'p2beta.mini'] },
  none: { plugins: build(() => false), providers: [] },
  'digest and alpha': { plugins: [digest, alpha], providers: ['p2alpha'] },
  'beta alone': { plugins: [beta], providers: ['p2beta', 'p2beta.mini'] },
  'without usage': { plugins: build((id) => id !== usage.manifest.id), providers: ['p2alpha', 'p2beta', 'p2beta.mini'] },
};

describe.each(Object.entries(BUILDS))('the %s build', (_name, { plugins, providers }) => {
  it('passes checkBundled, declares the providers it includes, and shows the usage panel only with its plugin', () => {
    // As the build checks it: against every plugin folder's catalog.
    expect(() => checkBundled(plugins, anchorCatalog(FIXTURE_PLUGINS))).not.toThrow();
    const ids = plugins.map((p) => p.manifest.id);
    expect(providerDeclarations(plugins).map((d) => d.id)).toEqual(providers);
    const presets = buildPresets(panelsOf(plugins));
    for (const preset of Object.values(presets)) {
      expect(panelIds(preset.root).includes(USAGE_PANEL)).toBe(ids.includes(usage.manifest.id));
      // Digest's preset places follow the usage panel's slot, which the host layouts keep whether or not it is built.
      expect(panelIds(preset.root).includes(DIGEST_PANEL)).toBe(ids.includes(digest.manifest.id));
    }
  });
});
