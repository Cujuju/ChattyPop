import { createRequire } from 'node:module';
import { beforeEach, expect, it, vi } from 'vitest';
import type { TileNode } from '@cujuju/solidjs-tiling-window-manager';

vi.mock('@cujuju/solidjs-tiling-window-manager', () => import('./tilingToolkitMock').then((m) => m.loadToolkit()));
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs'));
vi.mock('@plugin-sdk/renderer/containment', () => ({ containedRoot: (fn: () => unknown) => fn() }));
const host = vi.hoisted(() => ({ settings: new Map<string, unknown>(), writes: [] as string[] }));
vi.mock('@plugin-sdk/renderer/settings', async () => {
  const { createSignal } = await import('solid-js');
  return {
    createSetting: (key: string, fallback: unknown, normalize: (v: unknown) => unknown) => {
      const [get, set] = createSignal(host.settings.has(key) ? normalize(host.settings.get(key)) : fallback);
      return [get, (value: unknown) => { host.writes.push(key); host.settings.set(key, value); set(() => normalize(value)); }];
    },
    sameIds: (a: string[], b: string[]) => a.join('\0') === b.join('\0'),
  };
});
vi.mock('@/state/plugins', () => ({ pluginActive: () => true, plugins: () => [] }));
vi.mock('@/state/ui', () => ({ outsideLayout: false, isDialogPanel: () => false,
  openPanelDialog: vi.fn(), openPanelWindow: vi.fn(), setPlacingPanel: vi.fn() }));
const statePath = '../src/renderer/src/state/layout';
interface LayoutState {
  shownTiles(): TileNode | undefined;
  setShownTiles(next: TileNode | undefined): void;
  isPanelCollapsed(id: string): boolean;
  setPanelCollapsed(id: string, collapsed: boolean): void;
  sidebarCollapsed(): boolean;
  setSidebarCollapsed(value: boolean): void;
  resetLayout(): void;
}
const state = async (): Promise<LayoutState> => import(statePath);
beforeEach(() => { vi.resetModules(); host.settings.clear(); host.writes = []; });

it('resets a migrated custom layout to the persisted default tree', async () => {
  host.settings.set('layout.preset', 'custom-1');
  host.settings.set('layout.custom', { 'custom-1': { version: 1, name: 'Saved', root: { kind: 'panel', id: 'chat' } } });
  const layout = await state();
  const { DEFAULT_TILES } = await import('../src/renderer/src/layout/presets');
  expect(layout.shownTiles()).toEqual({ kind: 'tile', id: 'chat' });
  layout.resetLayout();
  expect(host.settings.get('layout.tiles')).toEqual(DEFAULT_TILES);
  expect(layout.shownTiles()).toEqual(DEFAULT_TILES);
  expect(host.writes).toEqual(['layout.tiles']);
});

it('separates the channels rail from folds and only writes the additive tile setting', async () => {
  host.settings.set('layout.tiles', { kind: 'split', dir: 'row', sizes: [1, 5],
    children: [{ kind: 'tile', id: 'channels' }, { kind: 'tile', id: 'chat' }] });
  const layout = await state();
  const shown = layout.shownTiles();
  expect(layout.shownTiles()).toBe(shown);
  layout.setShownTiles(shown);
  expect(host.writes).toEqual([]);
  layout.setSidebarCollapsed(true);
  expect(layout.sidebarCollapsed()).toBe(true);
  expect(layout.isPanelCollapsed('channels')).toBe(false);
  layout.setPanelCollapsed('channels', true);
  expect(layout.isPanelCollapsed('channels')).toBe(false);
  expect(host.writes).toEqual(['layout.tiles']);
  layout.setSidebarCollapsed(false);
  expect(layout.sidebarCollapsed()).toBe(false);
});

it('ignores garbage saved tiles and custom layouts without writing legacy settings', async () => {
  host.settings.set('layout.tiles', { garbage: true });
  host.settings.set('layout.custom', { 'custom-1': 'garbage' });
  host.settings.set('layout.preset', 'custom-1');
  const layout = await state();
  expect(layout.shownTiles()).toBeDefined();
  expect(host.writes).toEqual([]);
});

it('ignores an edit removing the final stored tile', async () => {
  host.settings.set('layout.tiles', { kind: 'tile', id: 'chat' });
  const layout = await state();
  const before = layout.shownTiles();
  layout.setShownTiles(undefined);
  expect(layout.shownTiles()).toBe(before);
  expect(host.writes).toEqual([]);
});
