vi.mock('@cujuju/solidjs-tiling-window-manager', () => import('./tilingToolkitMock').then((m) => m.loadToolkit()));
import { expect, it, vi } from 'vitest';
import { findSlot, normalize, resizeSplit, setActiveTab, tileIds, type TileNode } from '@cujuju/solidjs-tiling-window-manager';
import { DEFAULT_TILES, buildDefaultTiles } from '../src/renderer/src/layout/presets';
import { foldPanel, restoreHidden, shownTree } from '../src/renderer/src/layout/tiles';
import type { LayoutNode } from '../src/renderer/src/layout/types';

const tile = (id: string): TileNode => ({ kind: 'tile', id });
const panel = (id: string): LayoutNode => ({ kind: 'panel', id });

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

it('keeps a changed visible selection when the stored active tab is hidden', () => {
  const stored: TileNode = { kind: 'tabs', active: 1, children: [
    { kind: 'tile', id: 'a' }, { kind: 'tile', id: 'hidden' }, { kind: 'tile', id: 'b' },
  ] };
  const hidden = new Set(['hidden']);
  const edited = setActiveTab(shownTree(stored, hidden)!, 'a', 0);
  const restored = restoreHidden(stored, edited, hidden)!;
  expect(restored.kind === 'tabs' && restored.children[restored.active]!.id).toBe('a');
  const shown = shownTree(restored, hidden)!;
  expect(shown.kind === 'tabs' && shown.children[shown.active]!.id).toBe('a');
});

it('folds toward top first and bottom when there is no later neighbour', () => {
  const root: TileNode = { kind: 'split', dir: 'column', sizes: [1, 1], children: [tile('a'), tile('b')] };
  expect(findSlot(foldPanel(root, 'a'), 'a')?.slot.collapsed?.edge).toBe('top');
  expect(findSlot(foldPanel(root, 'b'), 'b')?.slot.collapsed?.edge).toBe('bottom');
});

it('retains newly placed panels when every stored panel is hidden', () => {
  expect(tileIds(restoreHidden(tile('hidden'), tile('new'), new Set(['hidden'])))).toEqual(['new', 'hidden']);
});
