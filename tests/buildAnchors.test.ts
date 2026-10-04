// A build that leaves out an anchor's owner still starts, placing items where the complete catalog's declarations lead.
import { describe, expect, it } from 'vitest';
import { HOST_PANELS, placeByAnchor } from '@shared/anchors';
import { type PluginDescriptor } from '@shared/bundledTypes';
import { anchorCatalog, checkBundled } from '@shared/bundledCheck';
import { P1_PLUGINS } from './p1Plugins';
import { EVALUATE_TIMEOUT_MS, registryFor } from './p1PluginFolders';

const panelOrder = (registry: typeof import('@shared/bundledPlugins')): string[] =>
  placeByAnchor<string>([...HOST_PANELS], registry.bundledPanels().map((p) => p.id), (id) => id, registry.panelAnchor);

const descriptor = (id: string, after: string): PluginDescriptor => ({
  manifest: { id, name: id, version: '1', description: '' },
  panels: [{ id, title: id, importance: 'reference', dialog: false, iconPath: '', after }],
});

describe('anchors whose owner a build leaves out', () => {
  it('a Meter build without Labels starts and places its panel where the full build does', async () => {
    const meterOnly = await registryFor('meter');
    expect(meterOnly.BUNDLED_PLUGINS.map((p) => p.manifest.id)).toEqual(['meter']);
    const full = await registryFor('meter,labels');
    const order = panelOrder(full).filter((id) => id !== 'labels');
    expect(panelOrder(meterOnly)).toEqual(order);
    expect(order.indexOf('meter')).toBe(order.indexOf('chat') + 1);
    // Its catalog has the slot items of plugins it leaves out, so theirs anchor as in the full build.
    expect(meterOnly.slotAnchor('messageMenu', 'labels.labels')).toEqual({ before: 'jev' });
    expect(meterOnly.slotAnchor('ruleTemplates', 'digest.digest')).toBe(full.slotAnchor('ruleTemplates', 'digest.digest'));
  }, EVALUATE_TIMEOUT_MS);

  it('still refuses anchors no plugin folder provides, and loops', () => {
    const catalog = anchorCatalog(P1_PLUGINS);
    expect(() => checkBundled([descriptor('one', 'lbels')], anchorCatalog([...P1_PLUGINS, descriptor('one', 'lbels')]))).toThrow(/lbels/);
    expect(() => checkBundled([descriptor('one', 'two')], anchorCatalog([descriptor('one', 'two'), descriptor('two', 'one')]))).toThrow(/loops/);
    expect(() => checkBundled(P1_PLUGINS.filter((p) => p.manifest.id === 'meter'), catalog)).not.toThrow();
  });
});
