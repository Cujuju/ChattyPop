// Baseline menu, rule choice and shortcut order survives plugin removal and build order changes.
import { describe, expect, it } from 'vitest';
import { HOST_MESSAGE_MENU_GROUPS, HOST_SHORTCUTS, placeByAnchor, type PlacementAnchor } from '@shared/anchors';
import { BUNDLED_PLUGINS } from '@shared/bundledPlugins';
import type { ArchiveMessage } from '@shared/contract';
import type { PluginDescriptor } from '@shared/bundledTypes';
import { orderedRuleKinds } from '@shared/ruleKinds/order';
import { ruleKinds } from '@shared/ruleKinds';
import { HOST } from '@shared/ruleKinds/catalog';
import { anchorCatalog, catalogSlotAnchor, checkBundled } from '@shared/bundledCheck';
import { readSlots, type ReadSlotEntry } from '../src/renderer/src/plugins/readSlots';
import { P1_PLUGINS, digest, inbox, labels, voice } from './p1Plugins';

const message = {
  id: 'm',
  labels: [],
} as unknown as ArchiveMessage;
const scope = { drawsAttachments: true };
const item = (label: string) => ({
  label,
  icon: 'text' as const,
  run: () => undefined,
});
const host = HOST_MESSAGE_MENU_GROUPS.map((id) => ({
  id,
  items: [item(id)],
}));
const entries: ReadSlotEntry[] = [
  {
    plugin: labels,
    contributions: { messageMenu: { labels: { calls: [], menu: () => [item('labels')] } } },
  },
  {
    plugin: voice,
    contributions: { messageMenu: { transcribe: { calls: [], menu: () => [item('voice')] } } },
  },
];
/** A probe group after Labels' group. */
const probe: ReadSlotEntry = {
  plugin: {
    manifest: {
      id: 'probe',
      name: 'Probe',
      version: '1',
      description: '',
    },
    slots: { messageMenu: [{ id: 'menu', after: 'labels.labels' }] },
  },
  contributions: { messageMenu: { menu: { calls: [], menu: () => [item('probe')] } } },
};
/** Read slots placed by the complete catalog: every plugin folder's declarations, whichever the build includes. */
const slotsOf = (list: readonly ReadSlotEntry[], enabled: (id: string) => boolean) =>
  readSlots(() => list, enabled, () => true, catalogSlotAnchor(anchorCatalog([...entries, probe].map((entry) => entry.plugin))));
const baselineMenu = ['selection', 'views', 'copy', 'voice', 'labels', 'jev', 'delete'];
const baselineRules = {
  triggers: ['message', 'labels.applied', 'timed'],
  filters: ['contains', 'linkPlatforms', 'linkDomains', 'labels.any'],
  actions: ['inbox.notify', 'labels.apply', 'digest.summarize', 'file', 'command', 'poster.post'],
} as const;

describe.each([undefined, 'labels', 'voice'])(
  'placement without %s',
  (absent) => {
    it.each([false, true])(
      'keeps the baseline menu order with reversed build order = %s',
      (reverse) => {
        const available = entries.filter((entry) => entry.plugin.manifest.id !== absent);
        const ordered = reverse ? [...available].reverse() : available;
        const groups = slotsOf(ordered, () => true).messages(message, scope, host);
        expect(groups.flatMap((group) => group.items.map((entry) => entry.label))).toEqual(baselineMenu.filter((id) => id !== absent));
      },
    );
    it(
      'keeps menu placement when a plugin is disabled at runtime',
      () => {
        const groups = slotsOf(entries, (id) => id !== absent).messages(message, scope, host);
        expect(groups.flatMap((group) => group.items.map((entry) => entry.label))).toEqual(baselineMenu.filter((id) => id !== absent));
      },
    );
    it.each([false, true])(
      'keeps baseline rule choices with reversed build order = %s',
      (reverse) => {
        const available = P1_PLUGINS.filter((plugin) => plugin.manifest.id !== absent);
        const ordered = reverse ? [...available].reverse() : available;
        for (const section of ['triggers', 'filters', 'actions'] as const) {
          expect(orderedRuleKinds(section, ordered).map((kind) => kind.type))
        .toEqual(baselineRules[section].filter((type) => absent !== 'labels' || !type.startsWith('labels.')));
        }
      },
    );
  },
);

it(
  'uses anchored order in the production rule registry',
  () => {
    const list = BUNDLED_PLUGINS as PluginDescriptor[];
    const previous = list.splice(0, list.length, ...P1_PLUGINS);
    try {
      for (const section of ['triggers', 'filters', 'actions'] as const) {
        expect(ruleKinds(section).map((kind) => kind.type)).toEqual(baselineRules[section]);
      }
    } finally {
      list.splice(0, list.length, ...previous);
    }
  },
);

it(
  'retains empty host groups as anchors until placement finishes',
  () => {
    const emptyJev = host.map((group) => group.id === 'jev' ? {
      ...group,
      items: [],
    } : group);
    const groups = slotsOf(entries, () => true).messages(message, scope, emptyJev);
    expect(groups.flatMap((group) => group.items.map((entry) => entry.label))).toEqual(baselineMenu.filter((id) => id !== 'jev'));
  },
);

it(
  'places groups around stamped plugin anchors, following a disabled or absent anchor to its own place',
  () => {
    const slots = slotsOf([probe, ...entries], () => true);
    expect(slots.messages(message, scope, host).flatMap((group) => group.items.map((entry) => entry.label)))
    .toEqual(['selection', 'views', 'copy', 'voice', 'labels', 'probe', 'jev', 'delete']);
    const off = slotsOf([probe, ...entries], (id) => id !== 'labels');
    expect(off.messages(message, scope, host).flatMap((group) => group.items.map((entry) => entry.label)))
    .toEqual(['selection', 'views', 'copy', 'voice', 'probe', 'jev', 'delete']);
    // Labels left out of the build: the catalog keeps its group's place, before jev.
    const absent = slotsOf([probe], () => true);
    expect(absent.messages(message, scope, host).flatMap((group) => group.items.map((entry) => entry.label)))
    .toEqual(['selection', 'views', 'copy', 'probe', 'jev', 'delete']);
  },
);

it(
  'places rule kinds after another plugin kind and appends unknown anchors',
  () => {
    const base = labels.rules!.actions![0]!;
    const probe: PluginDescriptor = {
      manifest: {
        id: 'probe',
        name: 'Probe',
        version: '1',
        description: '',
      },
      rules: {
        actions: [{
          ...base,
          type: 'probe.next',
          after: 'labels.apply',
        }, {
          ...base,
          type: 'probe.unknown',
          after: 'missing',
        }],
      },
    };
    expect(orderedRuleKinds('actions', [probe, labels, inbox, digest]).map((kind) => kind.type))
    .toEqual(['inbox.notify', 'labels.apply', 'probe.next', 'digest.summarize', 'file', 'command', 'probe.unknown']);
    expect(orderedRuleKinds('actions', [probe, inbox, digest]).map((kind) => kind.type))
    .toEqual(['inbox.notify', 'digest.summarize', 'file', 'command', 'probe.next', 'probe.unknown']);
  },
);

it(
  'preserves after placement and supports before chains without silently losing cycles',
  () => {
    const anchors: Record<string, PlacementAnchor> = {
      x: { before: 'b' },
      y: { before: 'x' },
      z: 'gone',
      gone: { before: 'b' },
      tail: 'missing',
    };
    expect(placeByAnchor(['a', 'b'], ['x', 'y', 'z', 'tail'], (id) => id, (id) => anchors[id]))
    .toEqual(['a', 'y', 'x', 'z', 'b', 'tail']);
    expect(() => placeByAnchor(['a'], ['x', 'y'], (id) => id, (id) => id === 'x' ? 'y' : 'x')).toThrow(/loops/);
  },
);

it('places plugin shortcuts by their anchors, keeping their place beside another plugin shortcut', () => {
  expect(() => checkBundled([digest], anchorCatalog(P1_PLUGINS))).not.toThrow();
  const shortcuts = [...digest.shortcuts!, { key: 'x', after: 'k' }];
  const anchors = new Map(shortcuts.map((shortcut) => [shortcut.key, shortcut.after]));
  const host = Object.keys(HOST_SHORTCUTS);
  expect(placeByAnchor(host, shortcuts.map((shortcut) => shortcut.key), (key) => key, (key) => anchors.get(key)))
    .toEqual(['layout', 'j', 'k', 'x', ...host.slice(1)]);
  expect(placeByAnchor(host, ['x'], (key) => key, (key) => anchors.get(key)))
    .toEqual(['layout', 'x', ...host.slice(1)]);
});

describe('rule kinds placed before a host anchor', () => {
  const probe = (before: string): PluginDescriptor => ({
    manifest: {
      id: 'probe',
      name: 'Probe',
      version: '1',
      description: '',
    },
    rules: { actions: [{ ...inbox.rules!.actions![0]!, type: 'probe.notify', before }] },
  });

  it('places a probe before its anchor and preserves host order without the probe', () => {
    const types = orderedRuleKinds('actions', [probe('digest.summarize'), digest]).map((kind) => kind.type);
    expect(types.indexOf('probe.notify') + 1).toBe(types.indexOf('digest.summarize'));
    expect(orderedRuleKinds('actions', [])).toEqual(HOST.actions);
    expect(orderedRuleKinds('actions', [probe('absent')]).at(-1)?.type).toBe('probe.notify');
  });

  it('rejects both placement directions on the same kind', () => {
    const p = probe('digest.summarize');
    p.rules!.actions![0]!.after = 'file';
    expect(() => checkBundled([p])).toThrow(/choose before or after/);
  });
});
