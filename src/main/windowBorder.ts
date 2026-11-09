import type { BrowserWindow } from 'electron';
import { nativeHandle, nativeWindowAddon } from './nativeWindowAddon';

const KEEP_BORDER_ENV = 'CHATTYPOP_KEEP_WINDOW_BORDER';

type StripFn = (hwnd: bigint) => boolean;

let strip: StripFn | null | undefined;

function loadStrip(): StripFn | null {
  if (strip !== undefined) return strip;
  strip = null;
  if (process.env[KEEP_BORDER_ENV] === '1') {
    console.log('[window-border] disabled via CHATTYPOP_KEEP_WINDOW_BORDER=1');
    return strip;
  }
  const addon = nativeWindowAddon();
  if (!addon) return strip;
  if (typeof addon.stripVisibleFrameBorder !== 'function') {
    console.warn('[electron] window-border addon loaded but has no stripVisibleFrameBorder export');
    return strip;
  }
  strip = addon.stripVisibleFrameBorder.bind(addon);
  return strip;
}

export function stripWindowBorder(win: BrowserWindow): void {
  const api = loadStrip();
  if (!api || win.isDestroyed()) return;
  try {
    const handle = nativeHandle(win);
    const applied = api(handle);
    console.log(`[window-border] strip applied=${applied} hwnd=${handle}`);
  } catch (err) {
    console.warn('[electron] could not strip window border:', (err as Error).message);
  }
}
