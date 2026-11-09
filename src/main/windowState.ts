import { readFileSync, writeFileSync } from 'node:fs';
import { screen, type BrowserWindow, type Rectangle } from 'electron';
import { errorMessage } from '@shared/errors';
import { applyScreenRect, readScreenRect, type ScreenRect } from './nativeWindowAddon';
import { diag } from './diagnostics';
import { profilePath } from './storageLocation';

/** How a window was last shown. `bounds` are its un-maximized bounds, so un-maximizing after a restore lands there. */
export interface WindowState {
  bounds: Rectangle;
  maximized: boolean;
  fullScreen: boolean;
  screen?: ScreenPlacement;
}

export interface SavedDisplay {
  id: number;
  scaleFactor: number;
  bounds: Rectangle;
  workArea: Rectangle;
}
export interface ScreenPlacement { rect: ScreenRect; display: SavedDisplay; }

const snapshotDisplay = (d: SavedDisplay): SavedDisplay => ({
  id: d.id, scaleFactor: d.scaleFactor, bounds: { ...d.bounds }, workArea: { ...d.workArea },
});

/** Physical placement is used only on the same unchanged display. */
export function placementStillValid(placement: ScreenPlacement, displays: readonly SavedDisplay[]): boolean {
  const was = placement.display;
  const now = displays.find((d) => d.id === was.id);
  const sameRect = (a: Rectangle, b: Rectangle): boolean => RECT_KEYS.every((k) => a[k] === b[k]);
  return !!now && now.scaleFactor === was.scaleFactor && sameRect(now.bounds, was.bounds) && sameRect(now.workArea, was.workArea);
}

export function parseScreenPlacement(raw: unknown): ScreenPlacement | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const p = raw as Partial<ScreenPlacement>;
  const rect = asRect(p.rect);
  const d = p.display;
  const bounds = asRect(d?.bounds);
  const workArea = asRect(d?.workArea);
  if (!rect || !d || !Number.isFinite(d.id) || !Number.isFinite(d.scaleFactor) || d.scaleFactor <= 0 || !bounds || !workArea) return undefined;
  return { rect, display: { id: d.id, scaleFactor: d.scaleFactor, bounds, workArea } };
}

const RECT_KEYS = ['x', 'y', 'width', 'height'] as const;

function asRect(v: unknown): Rectangle | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (!RECT_KEYS.every((k) => Number.isFinite(o[k]))) return undefined;
  if ((o['width'] as number) <= 0 || (o['height'] as number) <= 0) return undefined;
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
  const placement = parseScreenPlacement(o['screen']);
  return { bounds, maximized: o['maximized'] === true, fullScreen: o['fullScreen'] === true, ...(placement ? { screen: placement } : {}) };
}

/** Persists per-window states in profile JSON on close. After crashes, restores the last clean-close position. */
export class WindowStateFile {
  constructor(private readonly fileName: string) {}

  /** The saved state, unless missing, malformed, or off every connected display. */
  get(key: string): WindowState | undefined {
    return normalize(this.readAll()[key]);
  }

  /** Shows ready windows with saved state unless startHidden. Saves state on closes after first display; raiseWindow handles hidden starts. */
  manage(win: BrowserWindow, key: string, saved: WindowState | undefined, { startHidden = false } = {}): void {
    let ready = false;
    let wanted = !startHidden;
    let shown = false;
    // Tracked from events: a minimized or hidden window reports neither as it was.
    let maximized = saved?.maximized ?? false;
    let fullScreen = saved?.fullScreen ?? false;
    let placement: ScreenPlacement | undefined;
    const capturePlacement = (beforeRestore = false): void => {
      if (win.isDestroyed() || win.isMinimized()) return;
      if ((!beforeRestore && (maximized || fullScreen)) || win.isMaximized() || win.isFullScreen()) {
        if (placement && screen.getDisplayMatching(win.getBounds()).id !== placement.display.id) placement = undefined;
        return;
      }
      const rect = readScreenRect(win);
      if (rect) placement = { rect, display: snapshotDisplay(screen.getDisplayMatching(win.getBounds())) };
    };
    win.on('move', () => capturePlacement());
    win.on('resize', () => capturePlacement());
    const show = (): void => {
      if (!shown) {
        shown = true;
        if (saved?.screen && process.platform === 'win32' && placementStillValid(saved.screen, screen.getAllDisplays())) {
          if (applyScreenRect(win, saved.screen.rect)) placement = saved.screen;
        }
        capturePlacement(true);
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
      if (shown) {
        capturePlacement();
        this.save(key, { bounds: win.getNormalBounds(), maximized, fullScreen, ...(placement ? { screen: placement } : {}) });
      }
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
