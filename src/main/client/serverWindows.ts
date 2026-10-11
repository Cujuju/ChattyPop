// A server's windows in the client: its desktop page (or one panel of it), in a session of the server's own that keeps
// its pairing cookie. The page comes from the server, so it always matches the server's version.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { BrowserWindow, session, type Session, type WebContents } from 'electron';
import { APP_EVENT_CHANNEL, type AppEvent } from '@shared/contract';
import { SHELL_ORIGIN_ARG } from '@shared/desktopShell';
import { guardNavigation } from '../externalLinks';
import { guardUnsavedChanges, holdCloseIfUnsaved } from '../unsavedChanges';
import { WindowStateFile, raiseWindow } from '../windowState';

/** out/main, beside out/preload. */
const here = import.meta.dirname;
/** The one preload; its argument below makes it a server window's (src/preload/index.ts). */
const PRELOAD = join(here, '../preload/index.cjs');
/** The server's page for a remote desktop. */
const DESKTOP_PATH = '/desktop';
const windowState = new WindowStateFile('server-windows.json');
/** First-open sizes, before any placement is saved: the app's main window's, and a panel's. */
const MAIN_SIZE = { width: 1440, height: 960 } as const;
const PANEL_SIZE = { width: 560, height: 800 } as const;
/** Chromium's code for a load another navigation replaced. */
const ERR_ABORTED = -3;
/** What a server's page may ask of this computer: show notices and copy. Nothing else (camera, location, …). */
const ALLOWED_PERMISSIONS = new Set(['notifications', 'clipboard-sanitized-write', 'fullscreen']);

/** The persistent session a server's windows share: its pairing cookie and caches, apart from every other server's. */
export const serverPartition = (origin: string): string => `persist:server-${createHash('sha256').update(origin).digest('hex').slice(0, 16)}`;

/** The page a server window loads: the desktop UI, or one panel of it. */
export function serverPageUrl(origin: string, panel: string | null): string {
  const url = new URL(DESKTOP_PATH, origin);
  if (panel) url.searchParams.set('panel', panel);
  return url.href;
}

export interface ServerWindow {
  win: BrowserWindow;
  origin: string;
  /** The panel it shows on its own; null for the server's main window. */
  panel: string | null;
}

/**
 * The app's commands for one window's page (DesktopShell.onLocalEvent). A page gets them only once it listens: one sent
 * while it still loads, or shows the pairing page, would be lost, so it waits for the page instead.
 */
export class PageCommands {
  private listening = false;
  private readonly waiting: AppEvent[] = [];

  constructor(private readonly deliver: (e: AppEvent) => void) {}

  send(e: AppEvent): void {
    if (this.listening) this.deliver(e);
    else this.waiting.push(e);
  }

  /** The page subscribed: it gets what waited for it, in order. */
  listen(): void {
    this.listening = true;
    for (const e of this.waiting.splice(0)) this.deliver(e);
  }

  /** A new document loads in the window; it hasn't subscribed yet. */
  reset(): void {
    this.listening = false;
  }
}

export class ServerWindows {
  private readonly windows = new Set<ServerWindow>();
  private readonly guarded = new WeakSet<Session>();
  private readonly commands = new WeakMap<BrowserWindow, PageCommands>();

  /** `unreachable`: a window's page didn't load (the server is off, or this computer isn't on its network). */
  constructor(private readonly unreachable: (w: ServerWindow, reason: string) => void) {}

  /** Opens (or raises) `origin`'s main window, or its window for `panel`. */
  open(origin: string, panel: string | null = null): BrowserWindow {
    const open = [...this.windows].find((w) => w.origin === origin && w.panel === panel);
    if (open && raiseWindow(open.win)) return open.win;
    const ses = session.fromPartition(serverPartition(origin));
    this.guard(ses, origin);
    const key = `${origin}#${panel ?? 'main'}`;
    const saved = windowState.get(key);
    const win = new BrowserWindow({
      ...(saved?.bounds ?? (panel ? PANEL_SIZE : MAIN_SIZE)),
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        session: ses,
        preload: PRELOAD,
        // The only origin its preload gives the shell to.
        additionalArguments: [`${SHELL_ORIGIN_ARG}${origin}`],
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    windowState.manage(win, key, saved);
    const entry: ServerWindow = { win, origin, panel };
    this.windows.add(entry);
    win.on('closed', () => this.windows.delete(entry));
    const commands = new PageCommands((e) => {
      if (!win.isDestroyed()) win.webContents.send(APP_EVENT_CHANNEL, e);
    });
    this.commands.set(win, commands);
    win.webContents.on('did-navigate', () => commands.reset());
    // The server's pages only (its pairing page and its desktop); links elsewhere open in the system browser.
    guardNavigation(win.webContents, (url) => new URL(url).origin === origin);
    guardUnsavedChanges(win);
    win.on('close', (e) => void holdCloseIfUnsaved(win, e));
    // The page names itself ChattyPop; the title says which server.
    win.on('page-title-updated', (e, title) => {
      e.preventDefault();
      win.setTitle(`${title} · ${new URL(origin).host}`);
    });
    win.webContents.on('did-fail-load', (_e, code, reason, _url, mainFrame) => {
      // Aborted loads (ERR_ABORTED: a navigation replaced it) aren't failures.
      if (mainFrame && code !== ERR_ABORTED) this.unreachable(entry, reason);
    });
    void win.loadURL(serverPageUrl(origin, panel));
    return win;
  }

  /** Sends a command to a server window's page, once that page listens for them. */
  command(win: BrowserWindow, e: AppEvent): void {
    this.commands.get(win)?.send(e);
  }

  /** `wc`'s page subscribed to its commands (SHELL_CHANNELS.listening); anything but a server window is ignored. */
  listening(wc: WebContents): void {
    const w = this.of(wc);
    if (w) this.commands.get(w.win)?.listen();
  }

  /** The server window `wc` belongs to; undefined for anything else (a sender to refuse). */
  of(wc: WebContents): ServerWindow | undefined {
    return [...this.windows].find((w) => !w.win.isDestroyed() && w.win.webContents === wc);
  }

  /** `origin`'s main window, while it is open. */
  main(origin: string): BrowserWindow | undefined {
    return [...this.windows].find((w) => w.origin === origin && w.panel === null && !w.win.isDestroyed())?.win;
  }

  /** Every open server window. */
  all(): BrowserWindow[] {
    return [...this.windows].map((w) => w.win).filter((w) => !w.isDestroyed());
  }

  /** A server's session asks this computer for nothing beyond ALLOWED_PERMISSIONS, and only for its own pages. */
  private guard(ses: Session, origin: string): void {
    if (this.guarded.has(ses)) return;
    this.guarded.add(ses);
    const allowed = (permission: string, url: string): boolean => {
      try {
        return ALLOWED_PERMISSIONS.has(permission) && new URL(url).origin === origin;
      } catch {
        return false;
      }
    };
    ses.setPermissionRequestHandler((wc, permission, done) => done(allowed(permission, wc.getURL())));
    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => allowed(permission, requestingOrigin));
  }
}
