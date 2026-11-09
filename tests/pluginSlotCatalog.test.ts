// Slot items: host-stamped ids, one catalog over every plugin folder, and ids a phone or a layout stored before stamping.
vi.mock('@cujuju/solidjs-tiling-window-manager', () => import('./tilingToolkitMock').then((m) => m.loadToolkit()));
import { describe, expect, it, vi } from 'vitest';
import { definePlugin, type Adoption, type SlotDecls } from '@plugin-sdk/shared';
import { HOST_PANELS } from '@shared/anchors';
import { anchorCatalog, catalogSlotAnchor, checkBundled } from '@shared/bundledCheck';
import { adoptedPhoneSection, bundledPanel, slotAnchor } from '@shared/bundledPlugins';
import { frameSlots, phoneSectionOf, type FrameSlotEntry, type PhoneSection } from '../src/renderer/src/plugins/frameSlots';
import { normalize, tileIds } from '@cujuju/solidjs-tiling-window-manager';
import { panelOwnerOff } from '../src/renderer/src/layout/visibility';
import { P1_PLUGINS, digest, inbox, labels } from './p1Plugins';

// This build: the fixture plugins.
vi.mock('virtual:bundled-plugins/shared', () => import('./p1Registry'));

const probe = (id: string, slots: SlotDecls, adopts?: Pick<Adoption, 'phoneSections'>) =>
  definePlugin({ manifest: { id, name: id, version: '1', description: '' }, slots, ...(adopts && { adopts }) });
/** The build `CHATTYPOP_PLUGINS=meter` makes: its registry checked against every plugin folder's catalog. */
const meterOnly = P1_PLUGINS.filter((p) => p.manifest.id === 'meter');
const everyFolderWith = (...extra: ReturnType<typeof probe>[]) => anchorCatalog([...P1_PLUGINS, ...extra]);

describe('the slot catalog', () => {
  it('rejects a message-menu group declared twice, also in a build that leaves its plugin out', () => {
    const twice = probe('probe', { messageMenu: [{ id: 'menu', after: 'copy' }, { id: 'menu', before: 'jev' }] });
    expect(() => checkBundled([twice])).toThrow('Two messageMenu items are probe.menu');
    expect(() => checkBundled(meterOnly, everyFolderWith(twice))).toThrow('Two messageMenu items are probe.menu');
  });

  it('rejects an anchor no plugin folder provides, the owner known from the catalog alone', () => {
    const typo = probe('probe', { messageMenu: [{ id: 'menu', after: 'labels.lbels' }] });
    // Absent Labels items remain valid and sort last.
    expect(() => checkBundled([typo])).not.toThrow();
    expect(() => checkBundled([typo, labels])).toThrow('messageMenu item probe.menu follows labels.lbels, which no plugin provides');
    expect(() => checkBundled([typo], everyFolderWith(typo))).toThrow('follows labels.lbels');
    // Anchors naming undeclared items of present plugins fail validation.
    const plain = probe('plain', {});
    expect(() => checkBundled([probe('probe', { messageMenu: [{ id: 'menu', after: 'plain.menu' }] })], anchorCatalog([plain]))).toThrow('follows plain.menu');
    // A plugin a build leaves out answers for its own anchors when a build includes it, not here.
    expect(() => checkBundled(meterOnly, everyFolderWith(typo))).not.toThrow();
    // A host item of another slot is no anchor here.
    expect(() => checkBundled([probe('probe', { messageMenu: [{ id: 'menu', after: 'privacy' }] })])).toThrow('follows privacy');
  });

  it('rejects an anchor cycle, through the catalog too', () => {
    const one = probe('one', { messageMenu: [{ id: 'menu', after: 'two.menu' }] });
    const two = probe('two', { messageMenu: [{ id: 'menu', before: 'one.menu' }] });
    expect(() => checkBundled([one, two])).toThrow('placement loops');
    expect(() => checkBundled([one], everyFolderWith(one, two))).toThrow('placement loops');
    expect(() => checkBundled(meterOnly, everyFolderWith(one, two))).not.toThrow();
  });

  it("accepts the Meter-only build, whose catalog still places the plugins it leaves out", () => {
    expect(() => checkBundled(meterOnly, anchorCatalog(P1_PLUGINS))).not.toThrow();
    const anchorOf = catalogSlotAnchor(anchorCatalog(P1_PLUGINS));
    expect(anchorOf('messageMenu', 'labels.labels')).toEqual({ before: 'jev' });
    expect(anchorOf('phoneSections', 'inbox.inbox')).toBe('digest.summary');
    expect(anchorOf('topBar', 'privacy')).toBeUndefined();
  });

  it('refuses a local id that is not an identifier, two directions, and an alias to an undeclared section', () => {
    expect(() => checkBundled([probe('probe', { topBar: [{ id: 'a.b' }] })])).toThrow('topBar item a.b: its id must match');
    const both = { id: 'bell', after: 'layout', before: 'settings' } as unknown as { id: string };
    expect(() => checkBundled([probe('probe', { topBar: [both] })])).toThrow('choose before or after');
    expect(() => checkBundled([probe('probe', { phoneSections: [{ id: 'pane' }] }, { phoneSections: { old: 'gone' } })]))
      .toThrow('adopts phone section old');
  });
});

describe('phone sections a phone stored before ids were stamped', () => {
  const Component = () => null;
  // Inbox's and Digest's sections with the desktop panels their renderer sides present.
  const entries: FrameSlotEntry[] = [
    { plugin: inbox, contributions: { phoneSections: { inbox: { label: 'Inbox', section: 'inbox', Component } } } },
    { plugin: digest, contributions: { phoneSections: { summary: { label: 'Summary', section: 'summary', Component } } } },
  ];
  const host: PhoneSection[] = [{ id: 'archive', label: 'Archive', section: 'chat', Component }];
  const sections = frameSlots(() => entries, () => true, slotAnchor, () => undefined).phone(host);

  it('keep their order: Digest, Inbox, then the Archive', () => {
    expect(sections.map((s) => s.id)).toEqual(['digest.summary', 'inbox.inbox', 'archive']);
  });

  it.each([
    ['summary', 'digest.summary'],
    ['alerts', 'inbox.inbox'],
    ['archive', 'archive'],
  ])('a saved section choice %s opens %s', (saved, id) => {
    expect(phoneSectionOf(saved, sections, adoptedPhoneSection)).toBe(id);
  });

  it.each([
    ['summary', 'digest.summary'],
    ['inbox', 'inbox.inbox'],
    ['chat', 'archive'],
  ])("a notice's desktop panel target %s opens %s, the section presenting it", (panelId, id) => {
    expect(phoneSectionOf(panelId, sections, adoptedPhoneSection)).toBe(id);
    expect(phoneSectionOf(panelId, sections, () => undefined)).toBe(id);
  });

  it('resolve through the ids their plugins adopted, even where no panel shares the old id', () => {
    expect(adoptedPhoneSection('alerts')).toBe('inbox.inbox');
    expect(adoptedPhoneSection('summary')).toBe('digest.summary');
    const renamed: PhoneSection[] = [{ id: 'probe.pane', label: 'Probe', section: 'probe-panel', Component }];
    expect(phoneSectionOf('legacy', renamed, (old) => (old === 'legacy' ? 'probe.pane' : undefined))).toBe('probe.pane');
  });

  it('leave an id no section has alone', () => {
    expect(phoneSectionOf('gone', sections, adoptedPhoneSection)).toBeNull();
  });
});

it('a saved desktop layout keeps its panels', () => {
  // Shaped like a profile's `layout.tiles`: panel ids, which slot ids never replace.
  const saved: unknown = {
    kind: 'split',
    dir: 'row',
    sizes: [1, 3, 1],
    children: [
      { kind: 'tile', id: 'channels' },
      { kind: 'split', dir: 'column', sizes: [2, 1], children: [{ kind: 'tile', id: 'chat' }, { kind: 'tabs', active: 1, children: [{ kind: 'tile', id: 'inbox' }, { kind: 'tile', id: 'summary' }] }] },
      { kind: 'split', dir: 'column', sizes: [1, 1], children: [{ kind: 'tile', id: 'meter' }, { kind: 'tile', id: 'labels' }] },
    ],
  };
  const ids = tileIds(normalize(saved));
  const owned = ids.filter((id) => !(HOST_PANELS as readonly string[]).includes(id));
  expect(owned.map((id) => bundledPanel(id)?.pluginId)).toEqual(['inbox', 'digest', 'meter', 'labels']);
  const hidden = (id: string) => panelOwnerOff(id, (panel) => bundledPanel(panel)?.pluginId, () => true, []);
  expect(ids.filter(hidden)).toEqual([]);
});
