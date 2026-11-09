import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readScreenRect } from '../src/main/nativeWindowAddon';
import { tempDir } from './helpers';

/** One connected display; bounds anywhere else are off screen. */
const DISPLAY = { x: 0, y: 0, width: 1920, height: 1080 };
const env = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => env.userData },
  screen: { getDisplayMatching: vi.fn(() => ({ id: 1, scaleFactor: 1, bounds: DISPLAY, workArea: DISPLAY })) },
}));

vi.mock('../src/main/nativeWindowAddon', () => ({ readScreenRect: vi.fn(() => null), applyScreenRect: () => false }));

const { WindowStateFile, raiseWindow, parseScreenPlacement, placementStillValid } = await import('../src/main/windowState');

const FILE = 'windows.json';
const BOUNDS = { x: 100, y: 50, width: 800, height: 600 };

/** Just enough of a BrowserWindow: events, bounds, and a log of what was applied. Maximized state comes from events. */
function fakeWindow(bounds = BOUNDS) {
  const calls: string[] = [];
  const win = Object.assign(new EventEmitter(), {
    getNormalBounds: () => bounds,
    getBounds: () => bounds,
    isMaximized: () => false,
    isFullScreen: () => false,
    isDestroyed: () => false,
    isMinimized: () => false,
    maximize: () => void calls.push('maximize'),
    setFullScreen: (on: boolean) => void calls.push(`fullScreen:${on}`),
    show: () => void calls.push('show'),
    focus: () => undefined,
  });
  return { win: win as unknown as Electron.BrowserWindow, emit: (e: string) => win.emit(e), calls };
}

const writeRaw = (v: unknown): void => writeFileSync(join(env.userData, FILE), JSON.stringify(v));

beforeEach(() => {
  env.userData = tempDir();
  vi.mocked(readScreenRect).mockReset().mockReturnValue(null);
  vi.mocked(screen.getDisplayMatching).mockReset().mockReturnValue({
    id: 1, scaleFactor: 1, bounds: DISPLAY, workArea: DISPLAY,
  } as Electron.Display);
});

describe('WindowStateFile', () => {
  it('saves bounds and maximized state on close and restores them', () => {
    const w = fakeWindow();
    new WindowStateFile(FILE).manage(w.win, 'main', undefined);
    w.emit('ready-to-show');
    w.emit('maximize');
    w.emit('close');

    const saved = new WindowStateFile(FILE).get('main');
    expect(saved).toEqual({ bounds: BOUNDS, maximized: true, fullScreen: false });

    const next = fakeWindow();
    new WindowStateFile(FILE).manage(next.win, 'main', saved);
    next.emit('ready-to-show');
    expect(next.calls).toEqual(['maximize', 'show']);
  });

  it('restores full screen ahead of maximized', () => {
    const w = fakeWindow();
    new WindowStateFile(FILE).manage(w.win, 'main', { bounds: BOUNDS, maximized: true, fullScreen: true });
    w.emit('ready-to-show');
    expect(w.calls).toEqual(['fullScreen:true', 'show']);
  });

  it('drops physical placement after a maximized window moves to another display', () => {
    const displayA = { id: 1, scaleFactor: 1, bounds: DISPLAY, workArea: DISPLAY };
    const secondBounds = { ...DISPLAY, x: DISPLAY.width };
    const displayB = { ...displayA, id: 2, bounds: secondBounds, workArea: secondBounds };
    vi.mocked(screen.getDisplayMatching).mockImplementation((bounds) => (
      bounds.x >= secondBounds.x ? displayB : displayA
    ) as Electron.Display);
    vi.mocked(readScreenRect).mockReturnValue(BOUNDS);
    let bounds = BOUNDS;
    let currentBounds = BOUNDS;
    let maximized = false;
    const w = fakeWindow();
    w.win.getBounds = () => currentBounds;
    w.win.getNormalBounds = () => bounds;
    w.win.isMaximized = () => maximized;
    new WindowStateFile(FILE).manage(w.win, 'main', undefined);
    w.emit('ready-to-show');
    expect(readScreenRect).toHaveBeenCalledOnce();
    maximized = true;
    currentBounds = DISPLAY;
    w.emit('maximize');
    bounds = { ...BOUNDS, x: secondBounds.x + BOUNDS.x };
    currentBounds = secondBounds;
    w.emit('move');
    w.emit('close');

    expect(placementStillValid({ rect: BOUNDS, display: displayA }, [displayA, displayB])).toBe(true);
    expect(new WindowStateFile(FILE).get('main')).toEqual({ bounds, maximized: true, fullScreen: false });
  });

  it('keeps other windows when one saves', () => {
    const a = fakeWindow();
    const b = fakeWindow({ ...BOUNDS, x: 300 });
    const file = new WindowStateFile(FILE);
    file.manage(a.win, 'a', undefined);
    file.manage(b.win, 'b', undefined);
    a.emit('ready-to-show');
    b.emit('ready-to-show');
    a.emit('close');
    b.emit('close');
    expect(Object.keys(JSON.parse(readFileSync(join(env.userData, FILE), 'utf8')))).toEqual(['a', 'b']);
  });

  it('keeps a window started hidden in the tray until raised, then shows it in its saved state', () => {
    const saved = { bounds: BOUNDS, maximized: true, fullScreen: false };
    const w = fakeWindow();
    new WindowStateFile(FILE).manage(w.win, 'main', saved, { startHidden: true });
    w.emit('ready-to-show');
    expect(w.calls).toEqual([]);
    raiseWindow(w.win);
    expect(w.calls).toEqual(['maximize', 'show']);
  });

  it('shows a window raised before it is ready once it is', () => {
    const w = fakeWindow();
    new WindowStateFile(FILE).manage(w.win, 'main', undefined, { startHidden: true });
    raiseWindow(w.win);
    expect(w.calls).toEqual([]);
    w.emit('ready-to-show');
    expect(w.calls).toEqual(['show']);
  });

  it('keeps the saved state when a window closes without having been shown', () => {
    writeRaw({ main: { bounds: BOUNDS, maximized: true, fullScreen: false } });
    const file = new WindowStateFile(FILE);
    const w = fakeWindow({ ...BOUNDS, x: 300 });
    file.manage(w.win, 'main', file.get('main'), { startHidden: true });
    w.emit('ready-to-show');
    w.emit('close');
    expect(new WindowStateFile(FILE).get('main')).toEqual({ bounds: BOUNDS, maximized: true, fullScreen: false });
  });

  it('reads records saved as bare bounds', () => {
    writeRaw({ settings: BOUNDS });
    expect(new WindowStateFile(FILE).get('settings')).toEqual({ bounds: BOUNDS, maximized: false, fullScreen: false });
  });

  it('drops placements off every display', () => {
    writeRaw({ main: { bounds: { ...BOUNDS, x: DISPLAY.width + 10 }, maximized: false, fullScreen: false } });
    expect(new WindowStateFile(FILE).get('main')).toBeUndefined();
  });

  it('ignores malformed files and records', () => {
    writeRaw({ main: { bounds: { x: 'a', y: 0, width: 1, height: 1 } } });
    expect(new WindowStateFile(FILE).get('main')).toBeUndefined();
    writeRaw(null);
    expect(new WindowStateFile(FILE).get('main')).toBeUndefined();
    writeFileSync(join(env.userData, FILE), '{not json');
    expect(new WindowStateFile(FILE).get('main')).toBeUndefined();
  });
});

describe('physical placement contract', () => {
  const display = { id: 1, scaleFactor: 1.5, bounds: DISPLAY, workArea: DISPLAY };
  const placement = { rect: BOUNDS, display };
  it('requires finite positive placement dimensions and scale', () => {
    expect(parseScreenPlacement(placement)).toEqual(placement);
    for (const bad of [null, {}, { ...placement, rect: { ...BOUNDS, width: 0 } },
      { ...placement, rect: { ...BOUNDS, x: Infinity } }, { ...placement, display: { ...display, scaleFactor: 0 } }]) {
      expect(parseScreenPlacement(bad)).toBeUndefined();
    }
  });
  it('requires the same id, scale, bounds and work area', () => {
    expect(placementStillValid(placement, [{ ...display }])).toBe(true);
    for (const changed of [{ ...display, id: 2 }, { ...display, scaleFactor: 1 },
      { ...display, bounds: { ...DISPLAY, x: 1 } }, { ...display, workArea: { ...DISPLAY, height: 1000 } }]) {
      expect(placementStillValid(placement, [changed])).toBe(false);
    }
    expect(placementStillValid(placement, [])).toBe(false);
  });
});
