// Probe plugins exercise status-bar placement independently of renderer startup.
import { describe, expect, it } from 'vitest';
import { definePlugin, type SlotDecl } from '@plugin-sdk/shared';
import { HOST_STATUS_BAR_ITEMS } from '@shared/anchors';
import { anchorCatalog, catalogSlotAnchor, checkBundled } from '@shared/bundledCheck';
import { frameSlots, type FrameSlotEntry, type StatusBarContribution } from '../src/renderer/src/plugins/frameSlots';

const Component = () => null;
const host: StatusBarContribution[] = HOST_STATUS_BAR_ITEMS.map((id) => ({
  id,
  Component,
}));
const entry = (id: string, items: readonly SlotDecl[]): FrameSlotEntry => ({
  plugin: definePlugin({
    manifest: {
      id,
      name: id,
      version: '1',
      description: '',
    },
    slots: { statusBar: items },
  }),
  contributions: { statusBar: Object.fromEntries(items.map((item) => [item.id, { Component }])) },
});
const ids = (items: readonly StatusBarContribution[]) => items.map((item) => item.id);

describe('status-bar probe plugins', () => {
  it('places host anchors and follows disabled and absent owners through the catalog', () => {
    const owner = entry('owner', [{ id: 'item', after: 'disk' }]);
    const follower = entry('follower', [{ id: 'item', after: 'owner.item' }, { id: 'early', before: 'version' }]);
    let entries = [owner, follower];
    const active = new Set(['owner', 'follower']);
    const slots = frameSlots(() => entries, (id) => active.has(id), catalogSlotAnchor(anchorCatalog([owner.plugin, follower.plugin])), () => undefined);
    expect(ids(slots.statusBar(host))).toEqual([
      'capture', 'backfill', 'error', 'disk', 'owner.item', 'follower.item', 'jev', 'hints', 'restart', 'follower.early', 'version',
    ]);
    active.delete('owner');
    expect(ids(slots.statusBar(host))).toEqual([
      'capture', 'backfill', 'error', 'disk', 'follower.item', 'jev', 'hints', 'restart', 'follower.early', 'version',
    ]);
    entries = [follower];
    expect(ids(slots.statusBar(host))).toEqual([
      'capture', 'backfill', 'error', 'disk', 'follower.item', 'jev', 'hints', 'restart', 'follower.early', 'version',
    ]);
    active.clear();
    expect(slots.statusBar(host)).toEqual(host);
    entries = [];
    expect(slots.statusBar(host)).toEqual(host);
  });

  it('rejects an item declared twice by its plugin', () => {
    const twice = entry('probe', [{ id: 'item' }, { id: 'item', after: 'disk' }]);
    expect(() => checkBundled([twice.plugin])).toThrow('Two statusBar items are probe.item');
  });
});
