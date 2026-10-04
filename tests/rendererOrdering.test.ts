// Renderer ordering contracts: live-label snapshots, template and panel-menu order, preset splits (fixture plugins).
import { expect, it, vi } from 'vitest';
import { definePlugin } from '@plugin-sdk/shared';
import { placeByAnchor } from '@shared/anchors';
import { anchorCatalog, catalogSlotAnchor } from '@shared/bundledCheck';
import { labelRefresher } from '../src/main/plugins/labelAvailability';
import { declaredItems, placeSlot } from '../src/renderer/src/plugins/slotItems';
import { optionalPanelsFirst } from '../src/renderer/src/layout/menuOrder';
import { buildPresets } from '../src/renderer/src/layout/presets';
import { collapseSingles, panelIds, removePanel } from '../src/renderer/src/layout/tree';
import { PANEL_TITLES } from '../src/renderer/src/panels/titles';
import type { LayoutNode } from '../src/renderer/src/layout/types';
import { DIGEST_PANEL, EXTRA_PANEL, FIXTURE_PLUGINS, NOTES_PANEL, USAGE_PANEL, panelsOf } from './p2Fixtures';

it('keeps the last label snapshot while refreshing and publishes the new set once', async () => {
  let resolveLoad!: (value: string[]) => void;
  const publish = vi.fn();
  const load = vi.fn(() => new Promise<string[]>((resolve) => { resolveLoad = resolve; }));
  const refresh = labelRefresher(load, publish, () => undefined);
  refresh();
  await Promise.resolve();
  expect(publish).not.toHaveBeenCalled();
  resolveLoad(['tags']);
  await vi.waitFor(() => expect(publish).toHaveBeenCalledExactlyOnceWith(['tags']));
  publish.mockClear();
  refresh();
  await Promise.resolve();
  expect(publish).not.toHaveBeenCalled();
  resolveLoad([]);
  await vi.waitFor(() => expect(publish).toHaveBeenCalledExactlyOnceWith([]));
});

/** A plugin declaring rule templates (local id → anchor), each shown with its title. */
const templates = (id: string, decls: readonly ({ id: string; title: string } & ({ before: string } | { after: string }))[]) => ({
  plugin: definePlugin({
    manifest: { id, name: id, version: '1.0.0', description: '' },
    slots: { ruleTemplates: decls.map(({ title: _title, ...decl }) => decl) },
  }),
  views: Object.fromEntries(decls.map((d) => [d.id, { title: d.title }])),
});

it("places templates by their anchors with every plugin on, and resolves a left-out plugin's anchor", () => {
  const first = templates('first', [{ id: 'words', title: 'Words', before: 'host' }, { id: 'subject', title: 'Subject', after: 'first.words' }]);
  const second = templates('second', [{ id: 'voice', title: 'Voice', after: 'first.subject' }]);
  const middle = templates('middle', [{ id: 'tag', title: 'Tag', after: 'host' }]);
  const last = templates('last', [{ id: 'digest', title: 'Digest', after: 'middle.tag' }, { id: 'catchUp', title: 'Catch up', after: 'last.digest' }]);
  const entries = [first, second, middle, last];
  const host = [{ id: 'host', title: 'Host' }];
  // Every plugin folder's catalog, so a plugin left out of `on` still anchors the others.
  const anchorOf = catalogSlotAnchor(anchorCatalog(entries.map((e) => e.plugin)));
  const titles = (on: typeof entries) =>
    placeSlot<{ id: string; title: string }>('ruleTemplates', host, declaredItems(on, 'ruleTemplates', (e) => e.views), anchorOf).map((t) => t.title);
  expect(titles(entries)).toEqual(['Words', 'Subject', 'Voice', 'Host', 'Tag', 'Digest', 'Catch up']);
  expect(titles(entries.filter((e) => e !== middle))).toEqual(titles(entries).filter((title) => title !== 'Tag'));
});

it('orders the top bar and Add-below menu by panel anchors and collapses splits a left-out panel leaves', () => {
  const catalog = anchorCatalog(FIXTURE_PLUGINS);
  const panelAnchor = (id: string) => catalog.panels[id] ?? undefined;
  const fixtureIds = panelsOf(FIXTURE_PLUGINS).map((p) => p.id);
  const order = placeByAnchor<string>(Object.keys(PANEL_TITLES), fixtureIds, (id) => id, panelAnchor);
  expect(order).toEqual(['channels', 'sync-status', DIGEST_PANEL, USAGE_PANEL, 'chat', NOTES_PANEL, EXTRA_PANEL, 'status-bar']);
  // The usage panel's anchor is Digest's panel: left out, the usage panel takes Digest's own anchor.
  const withoutDigest = placeByAnchor<string>(Object.keys(PANEL_TITLES), fixtureIds.filter((id) => id !== DIGEST_PANEL), (id) => id, panelAnchor);
  expect(withoutDigest).toEqual(order.filter((id) => id !== DIGEST_PANEL));
  const detachable = order.filter((id) => !(id in PANEL_TITLES));
  const presetIds = new Set(Object.values(buildPresets(panelsOf(FIXTURE_PLUGINS))).flatMap((preset) => panelIds(preset.root)));
  expect(optionalPanelsFirst(detachable, presetIds)).toEqual([NOTES_PANEL, EXTRA_PANEL, DIGEST_PANEL, USAGE_PANEL]);
  const missing: LayoutNode = { kind: 'split', dir: 'row', sizes: [3, 2], children: [
    { kind: 'split', dir: 'column', sizes: ['auto'], children: [{ kind: 'panel', id: USAGE_PANEL }] },
    { kind: 'panel', id: 'chat' },
  ] };
  const enabled: LayoutNode = { ...missing, children: [
    { kind: 'split', dir: 'column', sizes: ['auto', 1], children: [{ kind: 'panel', id: USAGE_PANEL }, { kind: 'panel', id: DIGEST_PANEL }] },
    { kind: 'panel', id: 'chat' },
  ] };
  expect(collapseSingles(missing)).toEqual(removePanel(enabled, DIGEST_PANEL));
  const normalized = (node: LayoutNode): void => {
    if (node.kind === 'panel') return;
    if (node.kind === 'split') expect(node.children.length).not.toBe(1);
    node.children.forEach(normalized);
  };
  for (const preset of Object.values(buildPresets([]))) normalized(preset.root);
});
