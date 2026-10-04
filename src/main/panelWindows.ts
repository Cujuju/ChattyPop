import { readFileSync, writeFileSync } from 'node:fs';
import { BrowserWindow, app, type BrowserWindowConstructorOptions } from 'electron';
import { errorMessage } from '@shared/errors';
import { diag } from './diagnostics';
import { profilePath } from './storageLocation';
import { WindowStateFile, raiseWindow } from './windowState';

/** Where each panel window was last placed, so it reopens there. */
const STATE_FILE = 'panel-windows.json';
/** Panel ids whose windows were open when the app last closed, so the next start reopens them. */
const OPEN_FILE = 'panel-windows-open.json';
/** First-open size: a column of cards and an editor fit without scrolling sideways. */
const DEFAULT_SIZE = { width: 520, height: 720 } as const;
/** Smallest size that still shows a panel header and a few rows. */
const MIN_SIZE = { width: 320, height: 240 } as const;
/** Built-in ids and plugin:<plugin>:<panel> ids; anything else is refused. */
const PANEL_ID = /^[a-z][a-z0-9:_-]{0,120}$/i;
/** Panels that can't leave the main window: chat hosts the native Discord view. */
const MAIN_ONLY = new Set(['chat', 'channels', 'status-bar']);

/**
 * Panels opened in their own window: not modal, nothing behind them dimmed, kept above the main window (owned by it)
 * and closed with it. One window per panel; opening it again focuses it. Those still open when the app closes reopen on
 * the next start, once the main window shows.
 */
export class PanelWindows {
  private readonly open = new Map<string, BrowserWindow>();
  private readonly states = new WindowStateFile(STATE_FILE);
  /** The app is closing: windows closing now stay listed to reopen. */
  private ending = false;

  constructor(
    private readonly owner: BrowserWindow,
    /** Creates the window's web contents guards and loads the renderer showing just this panel. */
    private readonly load: (win: BrowserWindow, panelId: string) => void,
    /** Shared with the main window: icon, menu bar, preload and sandbox. */
    private readonly base: BrowserWindowConstructorOptions,
  ) {
    // Registered after the main window's own handler, so a close it holds (tray, graceful Discord unload) is seen as held.
    owner.on('close', (e) => {
      if (!e.defaultPrevented) this.ending = true;
    });
    app.on('before-quit', () => (this.ending = true));
    const reopen = (): void => {
      for (const id of this.readOpen()) this.show(id);
    };
    if (owner.isVisible()) reopen();
    else owner.once('show', reopen);
  }

  show(panelId: string): void {
    if (!PANEL_ID.test(panelId) || MAIN_ONLY.has(panelId)) return;
    const existing = this.open.get(panelId);
    if (existing && raiseWindow(existing)) return;
    const saved = this.states.get(panelId);
    const bounds = saved?.bounds ?? DEFAULT_SIZE;
    const win = new BrowserWindow({
      ...this.base,
      ...bounds,
      // A saved width under the minimum opens at the minimum.
      width: Math.max(bounds.width, MIN_SIZE.width),
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      parent: this.owner,
      show: false,
    });
    this.states.manage(win, panelId, saved);
    win.on('closed', () => {
      this.open.delete(panelId);
      if (!this.ending) this.writeOpen();
    });
    this.open.set(panelId, win);
    this.writeOpen();
    this.load(win, panelId);
  }

  private readOpen(): string[] {
    try {
      const ids: unknown = JSON.parse(readFileSync(profilePath(OPEN_FILE), 'utf8'));
      return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
    } catch {
      return []; // first start, or an unreadable file: none reopen
    }
  }

  private writeOpen(): void {
    try {
      writeFileSync(profilePath(OPEN_FILE), JSON.stringify([...this.open.keys()]));
    } catch (err) {
      diag('panel-windows-open-save-failed', { message: errorMessage(err) });
    }
  }

  /** Every open panel window, for pushing app events to them too. */
  windows(): BrowserWindow[] {
    return [...this.open.values()].filter((w) => !w.isDestroyed());
  }
}
