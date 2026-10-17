// The preload's role in a client's server window: the desktop shell (src/shared/desktopShell.ts), given to the server
// this window opened and to no other page it may reach.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { APP_EVENT_CHANNEL, DISCARD_UNSAVED_CHANNEL, UNSAVED_CHANNEL, type AppEvent } from '@shared/contract';
import { DESKTOP_SHELL_API_VERSION, DESKTOP_SHELL_GLOBAL, SHELL_CHANNELS, SHELL_ORIGIN_ARG, type DesktopShell } from '@shared/desktopShell';

/** The server main opened this window on (its additionalArguments); undefined in any other window. */
export const shellServer = (argv: readonly string[]): string | undefined => argv.find((a) => a.startsWith(SHELL_ORIGIN_ARG))?.slice(SHELL_ORIGIN_ARG.length);

const shell: DesktopShell = {
  apiVersion: DESKTOP_SHELL_API_VERSION,
  notify: (n) => ipcRenderer.send(SHELL_CHANNELS.notify, n),
  setBadge: (unread) => ipcRenderer.send(SHELL_CHANNELS.setBadge, unread),
  saveMedia: (path, fileName) => ipcRenderer.invoke(SHELL_CHANNELS.saveMedia, path, fileName),
  savePdf: (page) => ipcRenderer.invoke(SHELL_CHANNELS.savePdf, page),
  openPanelWindow: (panelId) => ipcRenderer.send(SHELL_CHANNELS.openPanelWindow, panelId),
  showInMainWindow: (channelId, messageId, compose) => ipcRenderer.send(SHELL_CHANNELS.showInMainWindow, channelId, messageId, compose),
  reportShownChannel: (channelId) => ipcRenderer.send(SHELL_CHANNELS.reportShownChannel, channelId),
  getShownChannel: () => ipcRenderer.invoke(SHELL_CHANNELS.getShownChannel),
  setUnsaved: (on) => ipcRenderer.send(UNSAVED_CHANNEL, on),
  discardUnsaved: () => ipcRenderer.send(DISCARD_UNSAVED_CHANNEL),
  onLocalEvent: (listener) => {
    const handler = (_e: IpcRendererEvent, event: AppEvent): void => listener(event);
    ipcRenderer.on(APP_EVENT_CHANNEL, handler);
    // Only now can a command reach the page; the app sends those it held for it.
    ipcRenderer.send(SHELL_CHANNELS.listening);
    return () => ipcRenderer.off(APP_EVENT_CHANNEL, handler);
  },
};

/** Gives the shell to the page when it is `server`'s: its pairing page and its desktop page share the origin; a page anywhere else gets nothing. */
export function exposeShell(server: string): void {
  // Preloads type-check without the DOM.
  const pageOrigin = (globalThis as unknown as { location?: { origin: string } }).location?.origin;
  if (pageOrigin === server) contextBridge.exposeInMainWorld(DESKTOP_SHELL_GLOBAL, shell);
}
