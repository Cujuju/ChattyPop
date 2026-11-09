import { BrowserWindow, ipcMain, type BrowserWindowConstructorOptions, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { MAC_TRAFFIC_LIGHTS_POSITION, WINDOW_CHROME_ARG, WINDOW_CONTROL_CHANNELS as channels, type WindowFrameState } from '@shared/windowControls';
import { stripWindowBorder } from './windowBorder';
import { closeFromOwner } from './windowClose';

const chrome = process.platform === 'darwin' ? 'traffic-lights' : 'controls';
const windows = new WeakSet<BrowserWindow>();
let registered = false;

export function windowChromeOptions(): BrowserWindowConstructorOptions {
  return process.platform === 'darwin'
    ? { titleBarStyle: 'hidden', trafficLightPosition: MAC_TRAFFIC_LIGHTS_POSITION }
    : { frame: false };
}
export const windowChromeArgs = (): string[] => [WINDOW_CHROME_ARG + chrome];
const state = (win: BrowserWindow): WindowFrameState => ({ maximized: win.isMaximized(), fullScreen: win.isFullScreen() });

/** Only the attached window's main frame may operate its controls. */
function caller(e: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow | undefined {
  const win = BrowserWindow.fromWebContents(e.sender);
  return win && windows.has(win) && e.senderFrame === e.sender.mainFrame ? win : undefined;
}
function registerHandlers(): void {
  if (registered) return;
  registered = true;
  ipcMain.on(channels.minimize, (e) => caller(e)?.minimize());
  ipcMain.on(channels.toggleMaximize, (e) => {
    const win = caller(e);
    if (!win) return;
    if (win.isFullScreen()) win.setFullScreen(false);
    else if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on(channels.close, (e) => {
    const win = caller(e);
    if (win) closeFromOwner(win);
  });
  ipcMain.handle(channels.state, (e) => {
    const win = caller(e);
    if (!win) throw new Error('Not a custom-framed window.');
    return state(win);
  });
}
/** Attaches before geometry restoration or the first show. */
export function attachWindowChrome(win: BrowserWindow): void {
  registerHandlers();
  windows.add(win);
  if (process.platform === 'win32') stripWindowBorder(win);
  const changed = (): void => {
    if (!win.isDestroyed()) win.webContents.send(channels.changed, state(win));
  };
  win.on('maximize', changed);
  win.on('unmaximize', changed);
  win.on('enter-full-screen', changed);
  win.on('leave-full-screen', changed);
}
