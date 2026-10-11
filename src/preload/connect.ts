// The preload's role in a client's own page that picks a server (connect.html).
import { contextBridge, ipcRenderer } from 'electron';
import { CONNECT_CHANNELS, CONNECT_GLOBAL, CONNECT_PAGE_ARG, type ConnectApi } from '@shared/desktopShell';

/** Whether this window is the connect page (its additionalArguments). */
export const isConnectPage = (argv: readonly string[]): boolean => argv.includes(CONNECT_PAGE_ARG);

const connect: ConnectApi = {
  list: () => ipcRenderer.invoke(CONNECT_CHANNELS.list),
  add: (input) => ipcRenderer.invoke(CONNECT_CHANNELS.add, input),
  remove: (origin) => ipcRenderer.invoke(CONNECT_CHANNELS.remove, origin),
  open: (origin) => ipcRenderer.invoke(CONNECT_CHANNELS.open, origin),
};

export const exposeConnect = (): void => contextBridge.exposeInMainWorld(CONNECT_GLOBAL, connect);
