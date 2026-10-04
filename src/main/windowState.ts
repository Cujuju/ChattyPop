import { readFileSync, writeFileSync } from 'node:fs';
import { screen, type BrowserWindow, type Rectangle } from 'electron';
import { errorMessage } from '@shared/errors';
import { diag } from './diagnostics';
import { profilePath } from './storageLocation';

/** How a window was last shown. `bounds` are its un-maximized bounds, so un-maximizing after a restore lands there. */
export interface WindowState {
  bounds: Rectangle;
  maximized: boolean;
  fullScreen: boolean;
}

const RECT_KEYS = ['x', 'y', 'width', 'height'] as const;

function asRect(v: unknown): Rectangle | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (!RECT_KEYS.every((k) => Number.isFinite(o[k]))) return undefined;
  return { x: o['x'] as number, y: o['y'] as number, width: o['width'] as number, height: o['height'] as number };
}

/** False when no connected display overlaps `b` (a monitor may have been unplugged). */
function onScreen(b: Rectangle): boolean {
  const area = screen.getDisplayMatching(b).workArea;
  return b.x < area.x + area.width && b.x + b.width > area.x && b.y < area.y + area.height && b.y + b.height > area.y;
}

function normalize(raw: unknown): WindowState | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  // Panel records saved before maximized/full-screen were tracked are bare bounds.
  const bounds = asRect(o['bounds']) ?? asRect(o);
  if (!bounds || !onScreen(bounds)) return undefined;
  return { bounds, maximized: o['maximized'] === true, fullScreen: o['fullScreen'] === true };
}

/**
 * Window states kept in one JSON file in the app profile, keyed per window.
 * Saved on close only: after a crash a window reopens where it was at its last clean close.
 */
export class WindowStateFile {
  constructor(private readonly fileName: string) {}

  /** The saved state, unless missing, malformed, or off every connected display. */
  get(key: string): WindowState | undefined {
    return normalize(this.readAll()[key]);
  }

  /**
   * Shows `win` (created with `show: false` and `saved.bounds`) in its saved state once ready, unless `startHidden`
   * (raiseWindow shows it then), and saves its state on every close once it has been shown.
   */
  manage(win: BrowserWindow, key: string, saved: WindowState | undefined, { startHidden = false } = {}): void {
    let ready = false;
    let wanted = !startHidden;
    let shown = false;
    // Tracked from events: a minimized or hidden window reports neither as it was.
    let maximized = saved?.maximized ?? false;
    let fullScreen = saved?.fullScreen ?? false;
    const show = (): void => {
      if (!shown) {
        shown = true;
        if (fullScreen) win.setFullScreen(true);
        else if (maximized) win.maximize();
      }
      win.show();
    };
    showers.set(win, () => {
      if (ready) show();
      else wanted = true;
    });
    win.once('ready-to-show', () => {
      ready = true;
      if (wanted) show();
    });
    win.on('maximize', () => (maximized = true));
    win.on('unmaximize', () => (maximized = false));
    win.on('enter-full-screen', () => (fullScreen = true));
    win.on('leave-full-screen', () => (fullScreen = false));
    win.on('close', () => {
      if (shown) this.save(key, { bounds: win.getNormalBounds(), maximized, fullScreen });
    });
  }

  private path(): string {
    return profilePath(this.fileName);
  }

  private readAll(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path(), 'utf8'));
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {}; // first open, or an unreadable file: default placement
    }
  }

  private save(key: string, state: WindowState): void {
    try {
      writeFileSync(this.path(), JSON.stringify({ ...this.readAll(), [key]: state }));
    } catch (err) {
      diag('window-state-save-failed', { file: this.fileName, message: errorMessage(err) });
    }
  }
}

/** How each managed window is shown: in its saved state the first time, and only once it is ready. */
const showers = new WeakMap<BrowserWindow, () => void>();

/** Brings `win` to the front, out of the tray or restored when minimized; false once it is gone. */
export function raiseWindow(win: BrowserWindow): boolean {
  if (win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  (showers.get(win) ?? (() => win.show()))();
  win.focus();
  return true;
}
