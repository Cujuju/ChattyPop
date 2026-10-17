// The desktop shell's calls in the client (src/shared/desktopShell.ts): notices, the badge, saving files and PDFs, panel
// windows and show-in-main. Each call is checked to come from a server window, and acts for that server only. Commands
// for a window go through ServerWindows.command, which holds them until its page listens.
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { app, dialog, ipcMain, nativeImage, Notification, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { isComposeIntent } from '@shared/contract';
import { SHELL_CHANNELS } from '@shared/desktopShell';
import { decodePdfSource } from '@shared/htmlPage';
import { targetEvent, type DeliveredNotification } from '@shared/notifications';
import { UNREAD_KINDS, normalizeUnreadTotals, unreadSummary } from '@shared/unread';
import { dotsBitmap } from '../badgeImage';
import { htmlToPdf } from '../pdf';
import { IS_MAC, IS_WINDOWS } from '../platform';
import { raiseWindow } from '../windowState';
import type { ServerWindow, ServerWindows } from './serverWindows';

/** The taskbar overlay's size in pixels (Windows' small icon at 100%). */
const OVERLAY_PX = 16;
const FALLBACK_PDF_NAME = 'export.pdf';

/** Asks where to save `name`; null when cancelled. */
async function saveAs(win: BrowserWindow, title: string, name: string, filters?: Electron.FileFilter[]): Promise<string | null> {
  const pick = await dialog.showSaveDialog(win, { title, defaultPath: join(app.getPath('downloads'), basename(name)), ...(filters ? { filters } : {}) });
  return pick.canceled || !pick.filePath ? null : pick.filePath;
}

export function registerShellHandlers(windows: ServerWindows): void {
  const shownChannels = new Map<string, string | null>();
  /** The server window a message came from; undefined for anything else, which is ignored. */
  const from = (e: IpcMainEvent): ServerWindow | undefined => windows.of(e.sender);
  /** The server window a call came from; a call from anything else is refused. */
  const caller = (e: IpcMainInvokeEvent): ServerWindow => {
    const w = windows.of(e.sender);
    if (!w) throw new Error('Not a server window.');
    return w;
  };

  ipcMain.on(SHELL_CHANNELS.notify, (e, n: DeliveredNotification) => {
    const w = from(e);
    if (!w || !Notification.isSupported() || typeof n?.title !== 'string' || typeof n.body !== 'string') return;
    const { origin } = w;
    const shown = new Notification({ title: n.title, body: n.body });
    shown.on('click', () => {
      const main = windows.main(origin) ?? windows.open(origin);
      if (!raiseWindow(main)) return;
      const opens = targetEvent(n.target ?? null);
      if (opens) windows.command(main, opens);
    });
    shown.show();
  });

  ipcMain.on(SHELL_CHANNELS.setBadge, (e, unread: unknown) => {
    const w = from(e);
    // The main window's totals; panel windows hold copies of the same stores.
    if (!w || w.panel !== null) return;
    const { win } = w;
    const totals = normalizeUnreadTotals(unread);
    const kinds = UNREAD_KINDS.filter((k) => totals[k] > 0);
    if (IS_WINDOWS) {
      const { width, height, data } = dotsBitmap(OVERLAY_PX, kinds);
      win.setOverlayIcon(kinds.length ? nativeImage.createFromBitmap(data, { width, height }) : null, unreadSummary(totals) ?? '');
    }
    if (IS_MAC) app.dock?.setBadge(kinds.length ? String(UNREAD_KINDS.reduce((n, k) => n + totals[k], 0)) : '');
  });

  ipcMain.handle(SHELL_CHANNELS.saveMedia, async (e, path: unknown, fileName: unknown) => {
    const { win, origin } = caller(e);
    if (typeof path !== 'string' || typeof fileName !== 'string' || !fileName) throw new Error('Not a file to save.');
    // The server's own files only, fetched with this window's pairing cookie.
    const url = new URL(path, origin);
    if (url.origin !== origin) throw new Error('Not a file on this server.');
    const target = await saveAs(win, 'Save attachment', fileName);
    if (!target) return;
    const reply = await win.webContents.session.fetch(url.href);
    if (!reply.ok) throw new Error(`The server answered ${reply.status}.`);
    await writeFile(target, Buffer.from(await reply.arrayBuffer()));
  });

  ipcMain.handle(SHELL_CHANNELS.savePdf, async (e, page: unknown) => {
    const { win } = caller(e);
    const source = decodePdfSource(page);
    const fileName = (page as { fileName?: unknown }).fileName;
    const target = await saveAs(win, 'Save PDF', typeof fileName === 'string' && fileName ? fileName : FALLBACK_PDF_NAME, [{ name: 'PDF', extensions: ['pdf'] }]);
    if (target) await writeFile(target, await htmlToPdf(source));
  });

  ipcMain.on(SHELL_CHANNELS.openPanelWindow, (e, panelId: unknown) => {
    const w = from(e);
    if (w && typeof panelId === 'string' && panelId) windows.open(w.origin, panelId);
  });

  ipcMain.on(SHELL_CHANNELS.showInMainWindow, (e, channelId: unknown, messageId: unknown, compose: unknown) => {
    const w = from(e);
    if (!w || typeof channelId !== 'string') return;
    const main = windows.main(w.origin) ?? windows.open(w.origin);
    if (!raiseWindow(main)) return;
    windows.command(main, { type: 'open-message', channelId, ...(typeof messageId === 'string' ? { messageId, ...(isComposeIntent(compose) ? { compose } : {}) } : {}) });
  });

  ipcMain.on(SHELL_CHANNELS.reportShownChannel, (e, channelId: unknown) => {
    const w = from(e);
    if (!w || w.panel !== null || (channelId !== null && typeof channelId !== 'string')) return;
    shownChannels.set(w.origin, channelId);
    for (const win of windows.all()) {
      const panel = windows.of(win.webContents);
      if (panel && panel.origin === w.origin && panel.panel !== null) windows.command(win, { type: 'shown-channel', channelId });
    }
  });
  ipcMain.handle(SHELL_CHANNELS.getShownChannel, (e) => shownChannels.get(caller(e).origin) ?? null);

  ipcMain.on(SHELL_CHANNELS.listening, (e) => windows.listening(e.sender));
}
