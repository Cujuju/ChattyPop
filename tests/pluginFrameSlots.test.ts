// Probe plugins exercise frame placement and unread sources without starting renderer stores.
import { describe, expect, it, vi } from 'vitest';
import { definePlugin, type PluginDescriptor, type SlotDecls } from '@plugin-sdk/shared';
import { HOST_PHONE_DRAWER_ITEMS, HOST_PHONE_SECTIONS, HOST_PROVIDER_ROWS, HOST_TOP_BAR_ITEMS } from '@shared/anchors';
import { anchorCatalog, catalogSlotAnchor } from '@shared/bundledCheck';
import { frameSlots, type FrameContributions, type FrameSlotEntry, type PhoneDrawerItem, type PhoneSection, type ProviderRow, type TopBarItem } from '../src/renderer/src/plugins/frameSlots';
import type { UnreadKind } from '@shared/unread';
import { createUnreadCounts } from '../src/renderer/src/state/unreadCounts';

const plugin = (id: string, slots?: SlotDecls): PluginDescriptor => definePlugin({
  manifest: {
    id,
    name: id,
    version: '1',
    description: '',
  },
  ...(slots && { slots }),
});
const Component = () => null;
const view = { Component };
const sectionView = (label: string) => ({ label, section: label, Component });
const entry = (id: string, slots: SlotDecls, contributions: FrameContributions): FrameSlotEntry => ({
  plugin: plugin(id, slots),
  contributions,
});
/** Frame slots over `all` entries' declarations, as the build's catalog places them. */
const slotsOf = (entries: () => readonly FrameSlotEntry[], all: readonly FrameSlotEntry[], enabled: (id: string) => boolean) =>
  frameSlots(entries, enabled, catalogSlotAnchor(anchorCatalog(all.map((e) => e.plugin))), () => undefined);
const hostTopBar: TopBarItem[] = HOST_TOP_BAR_ITEMS.map((id) => ({ id, Component }));
const hostPhone: PhoneSection[] = HOST_PHONE_SECTIONS.map((id) => ({ id, ...sectionView(id) }));
const ids = (items: readonly { id: string }[]) => items.map((item) => item.id);

describe('frame probe plugins', () => {
  it('stamps ids and places both slots before/after host and plugin anchors, following disabled and absent anchors', () => {
    const enabled = new Set(['first', 'second']);
    const first = entry('first', {
      topBar: [{ id: 'bell', after: 'privacy' }],
      phoneSections: [{ id: 'pane', before: 'archive' }],
    }, { topBar: { bell: view }, phoneSections: { pane: sectionView('first') } });
    const second = entry('second', {
      topBar: [{ id: 'next', after: 'first.bell' }, { id: 'early', before: 'settings' }],
      phoneSections: [{ id: 'next', after: 'first.pane' }, { id: 'late', after: 'archive' }],
    }, {
      topBar: { next: view, early: view },
      phoneSections: { next: sectionView('second'), late: sectionView('late') },
    });
    let entries = [first, second];
    const slots = slotsOf(() => entries, [first, second], (id) => enabled.has(id));
    expect(ids(slots.topBar(hostTopBar))).toEqual(['layout', 'privacy', 'first.bell', 'second.next', 'second.early', 'settings']);
    expect(ids(slots.phone(hostPhone))).toEqual(['first.pane', 'second.next', 'archive', 'second.late']);
    expect(slots.topBar(hostTopBar)[2]).toBe(slots.topBar(hostTopBar)[2]);
    enabled.delete('first');
    expect(ids(slots.topBar(hostTopBar))).toEqual(['layout', 'privacy', 'second.next', 'second.early', 'settings']);
    expect(ids(slots.phone(hostPhone))).toEqual(['second.next', 'archive', 'second.late']);
    // First is left out of the build: the catalog still has its items, so second's keep their places.
    entries = [second];
    expect(ids(slots.topBar(hostTopBar))).toEqual(['layout', 'privacy', 'second.next', 'second.early', 'settings']);
    expect(ids(slots.phone(hostPhone))).toEqual(['second.next', 'archive', 'second.late']);
    enabled.clear();
    expect(slots.topBar(hostTopBar)).toEqual(hostTopBar);
    expect(slots.phone(hostPhone)).toEqual(hostPhone);
    entries = [];
    expect(slots.topBar(hostTopBar)).toEqual(hostTopBar);
    expect(slots.phone(hostPhone)).toEqual(hostPhone);
  });

  it('places drawer panes among the host panes, following a disabled anchor and keeping the host panes when none are on', () => {
    const hostDrawer: PhoneDrawerItem[] = HOST_PHONE_DRAWER_ITEMS.map((id) => ({ id, label: id, section: id, Component }));
    const enabled = new Set(['usage', 'notes']);
    const entries = [
      entry('usage', { phoneDrawer: [{ id: 'plan', after: 'channels' }] }, { phoneDrawer: { plan: sectionView('plan') } }),
      entry('notes', { phoneDrawer: [{ id: 'notes', after: 'usage.plan' }, { id: 'top', before: 'channels' }] }, {
        phoneDrawer: { notes: sectionView('notes'), top: sectionView('top') },
      }),
    ];
    const slots = slotsOf(() => entries, entries, (id) => enabled.has(id));
    expect(ids(slots.phoneDrawer(hostDrawer))).toEqual(['notes.top', 'channels', 'usage.plan', 'notes.notes']);
    enabled.delete('usage');
    expect(ids(slots.phoneDrawer(hostDrawer))).toEqual(['notes.top', 'channels', 'notes.notes']);
    enabled.clear();
    expect(slots.phoneDrawer(hostDrawer)).toEqual(hostDrawer);
  });

  it("places provider-card rows among the host's rows, and drops a turned-off plugin's", () => {
    const hostRows: ProviderRow[] = HOST_PROVIDER_ROWS.map((id) => ({ id, Component: () => null }));
    const enabled = new Set(['usage']);
    const entries = [entry('usage', { providerRows: [{ id: 'display-name', after: 'enabled' }] }, { providerRows: { 'display-name': { Component: () => null } } })];
    const slots = slotsOf(() => entries, entries, (id) => enabled.has(id));
    expect(ids(slots.providerRows(hostRows))).toEqual(['enabled', 'usage.display-name', 'model', 'effort', 'plan-usage', 'rows']);
    enabled.clear();
    expect(slots.providerRows(hostRows)).toEqual(hostRows);
  });

  it('sums host and plugin counts once, reads them live, and drops disabled/absent sources without calling them', () => {
    let enabled = true;
    let count = 4;
    const read = vi.fn(() => count);
    const seen = vi.fn();
    const shown = vi.fn();
    let entries: FrameSlotEntry[] = [{
      plugin: plugin('probe'),
      contributions: {
        unread: {
          probe: {
            count: read,
            markSeen: seen,
            onShown: shown,
          },
          other: { count: () => 2 },
        },
      },
    }];
    const slots = slotsOf(() => entries, entries, () => enabled);
    const unread = createUnreadCounts();
    unread.host('host', { count: () => 3 });
    unread.plugins(slots.unread);
    expect(unread.total()).toBe(9);
    expect(unread.count('host')).toBe(3);
    expect(unread.count('probe')).toBe(4);
    unread.source('probe')?.markSeen?.();
    unread.source('probe')?.onShown?.();
    expect(seen).toHaveBeenCalledOnce();
    expect(shown).toHaveBeenCalledOnce();
    count = 7;
    expect(unread.total()).toBe(12);
    enabled = false;
    read.mockClear();
    expect(unread.count('probe')).toBe(0);
    expect(unread.source('probe')).toBeUndefined();
    expect(unread.total()).toBe(3);
    expect(read).not.toHaveBeenCalled();
    enabled = true;
    expect(unread.total()).toBe(12);
    entries = [];
    expect(unread.total()).toBe(3);
  });

  it('rejects colliding source ids, normalizes invalid counts, and keeps stamped items clear of host ids', () => {
    const unread = createUnreadCounts();
    unread.host('host', { count: () => 2 });
    unread.plugins(() => [
      ['negative', { count: () => -2 }],
      ['infinite', { count: () => Infinity }],
      ['fraction', { count: () => 2.9 }],
    ]);
    expect(unread.total()).toBe(4);
    unread.plugins(() => [['host', { count: () => 9 }]]);
    expect(() => unread.total()).toThrow('Duplicate unread source host');
    // A plugin item named like a host item is stamped with its plugin's id, so both show.
    const entries = [entry('probe', { topBar: [{ id: 'privacy' }] }, { topBar: { privacy: view } })];
    expect(ids(slotsOf(() => entries, entries, () => true).topBar(hostTopBar))).toEqual([...HOST_TOP_BAR_ITEMS, 'probe.privacy']);
  });

  it('splits totals by kind: chat as declared, alerts for sources naming none or a kind unknown', () => {
    const unread = createUnreadCounts();
    unread.host('chat', { kind: 'chat', count: () => 3 });
    unread.plugins(() => [
      ['declared', { kind: 'alerts', count: () => 1 }],
      ['unnamed', { count: () => 2 }],
      ['misnamed', { kind: 'mail' as UnreadKind, count: () => 4 }],
    ]);
    expect(unread.totals()).toEqual({ chat: 3, alerts: 7 });
    expect(unread.total()).toBe(10);
    unread.plugins(() => []);
    expect(unread.totals()).toEqual({ chat: 3, alerts: 0 });
  });
});
