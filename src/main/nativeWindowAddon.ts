import { createRequire } from 'node:module';
import type { BrowserWindow } from 'electron';
import { app } from 'electron';
import { join } from 'node:path';

/** A window rect in physical screen pixels (GetWindowRect), not Electron DIPs. */
export interface ScreenRect { x: number; y: number; width: number; height: number; }

/** Every export is optional: a stale binary can predate a function. */
interface NativeWindowAddon {
  stripVisibleFrameBorder?(hwnd: bigint): boolean;
  getWindowRect?(hwnd: bigint): ScreenRect | null;
  setWindowRect?(hwnd: bigint, x: number, y: number, width: number, height: number): boolean;
}

let addon: NativeWindowAddon | null | undefined;

/** The native window addon (native/window-border), or null off Windows / when it failed to build. */
export function nativeWindowAddon(): NativeWindowAddon | null {
  if (addon !== undefined) return addon;
  addon = null;
  if (process.platform !== 'win32') return addon;
  let windowBorderAddon = 'native/window_border.node';
  try {
    windowBorderAddon = app.isPackaged
      ? join(process.resourcesPath, 'native', 'window_border.node')
      : join(app.getAppPath(), 'native', 'window-border', 'build', 'Release', 'window_border.node');
    addon = createRequire(windowBorderAddon)(windowBorderAddon) as NativeWindowAddon;
    console.log(`[window-addon] loaded from ${windowBorderAddon}`);
  } catch (err) {
    console.warn(`[electron] native window addon unavailable (${windowBorderAddon}):`, (err as Error).message);
  }
  return addon;
}

export function nativeHandle(win: BrowserWindow): bigint {
  return win.getNativeWindowHandle().readBigUInt64LE(0);
}

/** Physical window rect, or null when the addon cannot read it. */
export function readScreenRect(win: BrowserWindow): ScreenRect | null {
  const read = nativeWindowAddon()?.getWindowRect;
  if (!read || win.isDestroyed()) return null;
  try {
    return read(nativeHandle(win));
  } catch (err) {
    console.warn('[electron] could not read the physical window rect:', (err as Error).message);
    return null;
  }
}

/** Sets the physical window rect without showing or activating the window. False when not applied. */
export function applyScreenRect(win: BrowserWindow, rect: ScreenRect): boolean {
  const apply = nativeWindowAddon()?.setWindowRect;
  if (!apply || win.isDestroyed()) return false;
  try {
    return apply(nativeHandle(win), rect.x, rect.y, rect.width, rect.height);
  } catch (err) {
    console.warn('[electron] could not set the physical window rect:', (err as Error).message);
    return false;
  }
}
