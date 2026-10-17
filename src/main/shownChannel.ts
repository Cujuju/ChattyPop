import { ipcMain, type BrowserWindow } from 'electron';
import { APP_EVENT_CHANNEL, GET_SHOWN_CHANNEL_CHANNEL, SHOWN_CHANNEL_CHANNEL } from '@shared/contract';
import type { PanelWindows } from './panelWindows';

/** Mirrors the main window's channel to its panels, including panels opened after the last change. */
export function registerShownChannelHandlers(owner: BrowserWindow, panels: Pick<PanelWindows, 'windows'>): void {
  let channelId: string | null = null;
  ipcMain.on(SHOWN_CHANNEL_CHANNEL, (e, value: unknown) => {
    if (e.sender !== owner.webContents || (value !== null && typeof value !== 'string')) return;
    channelId = value;
    for (const win of panels.windows()) win.webContents.send(APP_EVENT_CHANNEL, { type: 'shown-channel', channelId });
  });
  ipcMain.handle(GET_SHOWN_CHANNEL_CHANNEL, (e) => {
    const known = e.sender === owner.webContents || panels.windows().some((win) => win.webContents === e.sender);
    return known ? channelId : null;
  });
}
