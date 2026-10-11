// The desktop client app's shell around a remote desktop page: what its preload gives the page, and the channels it
// uses (src/preload/client.ts, src/main/client/). The page is served by the server, so it can be newer or older than
// the client app: it uses the shell only through this versioned contract, and works without one in a browser.
import type { PdfPage } from './htmlPage';
import type { DeliveredNotification } from './notifications';
import type { AppEvent, ComposeIntent } from './types/ipc';
import type { UnreadTotals } from './unread';

/** The global the client app's preload sets on a remote desktop page (only on the server it opened). */
export const DESKTOP_SHELL_GLOBAL = 'chattypopShell';
/** Raised when a member changes incompatibly; a page checks it before using the shell. */
export const DESKTOP_SHELL_API_VERSION = 1;

/** Native features the client app gives a remote desktop page. */
export interface DesktopShell {
  readonly apiVersion: number;
  /** Shows a notice as a system notification; a click raises the window and opens its target (onLocalEvent). */
  notify(n: DeliveredNotification): void;
  setBadge(unread: UnreadTotals): void;
  /** Downloads `path` (on the server, with this window's pairing cookie) and saves it where the owner picks. */
  saveMedia(path: string, fileName: string): Promise<void>;
  /** Draws `page` as a one-page PDF here and saves it where the owner picks. */
  savePdf(page: PdfPage): Promise<void>;
  /** Opens (or focuses) a panel in its own window on the same server. */
  openPanelWindow(panelId: string): void;
  /** From a panel window: shows a message (or channel) in this server's main window. */
  showInMainWindow(channelId: string, messageId?: string, compose?: ComposeIntent): void;
  /** Whether this window holds unsaved edits, so the app asks before closing it. */
  setUnsaved(on: boolean): void;
  discardUnsaved(): void;
  /** Commands for this window from the app (a notice clicked, a panel window's show-in-main). */
  onLocalEvent(listener: (e: AppEvent) => void): () => void;
}

/**
 * Page → client app calls (ipcRenderer.invoke / send). Unsaved edits and the app's commands for the window travel on the
 * app's own window channels (UNSAVED_CHANNEL, DISCARD_UNSAVED_CHANNEL, APP_EVENT_CHANNEL), so main guards a server's
 * window as it does its own (unsavedChanges.ts).
 */
export const SHELL_CHANNELS = {
  notify: 'shell:notify',
  setBadge: 'shell:set-badge',
  saveMedia: 'shell:save-media',
  savePdf: 'shell:save-pdf',
  openPanelWindow: 'shell:open-panel',
  showInMainWindow: 'shell:show-in-main',
} as const;
/** The argument the client app passes its server windows' preload: the only origin the shell is given to. */
export const SHELL_ORIGIN_ARG = '--cp-server-origin=';

/** The client app's own page for picking a server (connect.html): the argument its window passes the preload, its global and calls. */
export const CONNECT_PAGE_ARG = '--cp-connect-page';
/** The connect page's query when a server didn't load: which server, and Chromium's reason. */
export const CONNECT_UNREACHABLE_PARAMS = { origin: 'unreachable', reason: 'reason' } as const;
export const CONNECT_GLOBAL = 'chattypopConnect';
export const CONNECT_CHANNELS = {
  list: 'connect:list',
  add: 'connect:add',
  remove: 'connect:remove',
  open: 'connect:open',
} as const;
/** A server the client app knows, most recently used first. */
export interface SavedServer {
  origin: string;
  lastUsedAt: number;
}
/** What the connect page's preload gives it. `add` resolves with the origin it saved, or rejects with why it can't. */
export interface ConnectApi {
  list(): Promise<SavedServer[]>;
  add(input: string): Promise<string>;
  remove(origin: string): Promise<void>;
  open(origin: string): Promise<void>;
}

/** The shell the page may use: the client app's, when its contract matches; null in a browser or an older app. */
export function desktopShell(scope: object = globalThis): DesktopShell | null {
  const shell = (scope as Record<string, unknown>)[DESKTOP_SHELL_GLOBAL] as DesktopShell | undefined;
  return shell && shell.apiVersion === DESKTOP_SHELL_API_VERSION ? shell : null;
}
