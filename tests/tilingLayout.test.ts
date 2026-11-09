vi.mock('@cujuju/solidjs-tiling-window-manager', () => import('./tilingToolkitMock').then((m) => m.loadToolkit()));
import { expect, it, vi } from 'vitest';
import { findSlot, normalize, resizeSplit, tileIds, type TileNode } from '@cujuju/solidjs-tiling-window-manager';
import { convertLegacyNode, foldPanel, migrateLegacy } from '../src/renderer/src/layout/legacy';
import { DEFAULT_TILES, buildDefaultTiles } from '../src/renderer/src/layout/presets';
import { restoreHidden, shownTree } from '../src/renderer/src/layout/tiles';
import type { LayoutNode } from '../src/renderer/src/layout/types';

const tile = (id: string): TileNode => ({ kind: 'tile', id });
const panel = (id: string): LayoutNode => ({ kind: 'panel', id });

it('converts custom v1 tabs, auto shares and overrides, dropping retired and frame panels', () => {
  const root: LayoutNode = { kind: 'split', dir: 'column', sizes: [2, 'auto', 4], children: [
    { kind: 'tabs', active: 1, children: [{ kind: 'panel', id: 'unknown' }, { kind: 'panel', id: 'chat' }] },
    panel('channels'),
    { kind: 'split', dir: 'row', sizes: [1, 1, 1, 1], children: ['status-bar', 'topics', 'rules', 'sync-status'].map(panel) },
  ] };
  const migrated = migrateLegacy('custom-1', { 'custom-1': { version: 1, name: 'Saved', root } },
    { 'custom-1': { '': [6, 2] } }, false, [], DEFAULT_TILES);
  expect(migrated).toEqual({ kind: 'split', dir: 'column', sizes: [1, 4 / 6], children: [
    { kind: 'tabs', active: 1, children: [tile('unknown'), tile('chat')] }, tile('channels'),
  ] });
  expect(normalize(convertLegacyNode(panel('unknown')))).toEqual(tile('unknown'));
});

it('falls back for garbage settings and former built-in preset selections', () => {
  for (const garbage of [null, false, [], 'invalid', { 'custom-1': { version: 1, root: null } }]) {
    expect(() => normalize(garbage)).not.toThrow();
    expect(migrateLegacy('custom-1', garbage, garbage, false, [], DEFAULT_TILES)).toBe(DEFAULT_TILES);
  }
  expect(migrateLegacy('tabbed', {}, {}, false, [], DEFAULT_TILES)).toBe(DEFAULT_TILES);
});

it('places declarations anchored to the status bar before removing the fixed frame slot', () => {
  const root = buildDefaultTiles([{ id: 'probe', title: 'Probe', importance: 'primary', dialog: false,
    iconPath: '', after: 'chat', presets: [{ id: 'stacked', before: 'status-bar' }] }]);
  expect(tileIds(root)).toContain('probe');
  expect(tileIds(root)).not.toContain('status-bar');
});

it('retains hidden split ratios through projection and three unrelated resizes', () => {
  let stored: TileNode = { kind: 'split', dir: 'row', sizes: [2, 3, 5], children: [tile('a'), tile('hidden'),
    { kind: 'split', dir: 'column', sizes: [7, 11], children: [tile('b'), tile('c')] },
  ] };
  const hidden = new Set(['hidden']);
  const original = structuredClone(stored);
  for (let iteration = 0; iteration < 3; iteration++) {
    const shown = shownTree(stored, hidden)!;
    expect(restoreHidden(stored, shown, hidden)).toEqual(stored);
    const edited = resizeSplit(shown, [1], [11, 7]);
    stored = restoreHidden(stored, edited, hidden)!;
    expect(stored.kind === 'split' && stored.sizes).toEqual(original.sizes);
    expect(tileIds(stored)).toEqual(['a', 'hidden', 'b', 'c']);
  }
});

it('restores hidden tabs in order with the stored active tab', () => {
  const stored: TileNode = { kind: 'tabs', active: 1, children: [
    { kind: 'tile', id: 'a' }, { kind: 'tile', id: 'hidden' }, { kind: 'tile', id: 'b' },
  ] };
  const hidden = new Set(['hidden']);
  expect(restoreHidden(stored, shownTree(stored, hidden), hidden)).toEqual(stored);
});

it('folds toward top first and bottom when there is no later neighbour', () => {
  const root: TileNode = { kind: 'split', dir: 'column', sizes: [1, 1], children: [tile('a'), tile('b')] };
  expect(findSlot(foldPanel(root, 'a'), 'a')?.slot.collapsed?.edge).toBe('top');
  expect(findSlot(foldPanel(root, 'b'), 'b')?.slot.collapsed?.edge).toBe('bottom');
});

it('retains newly placed panels when every stored panel is hidden', () => {
  expect(tileIds(restoreHidden(tile('hidden'), tile('new'), new Set(['hidden'])))).toEqual(['new', 'hidden']);
});
