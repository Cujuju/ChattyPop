// Client mode (--connect): a ChattyPop server's desktop UI in this app's windows. No core, no Discord and no plugins
// here: the server has them all, and serves the page that matches its version. docs/server-client-split-plan.md §7.
import { join } from 'node:path';
import { BrowserWindow, Menu, app, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { CONNECT_CHANNELS, CONNECT_PAGE_ARG, CONNECT_UNREACHABLE_PARAMS } from '@shared/desktopShell';
import { guardNavigation } from '../externalLinks';
import { launchMode } from '../launchMode';
import { IS_MAC } from '../platform';
import { profilePath } from '../storageLocation';
import { raiseWindow } from '../windowState';
import { ServerList, fileStore } from './servers';
import { ServerWindows, type ServerWindow } from './serverWindows';
import { registerShellHandlers } from './shellHandlers';

/** out/main, beside out/preload and out/renderer. */
const here = import.meta.dirname;
/** The one preload; CONNECT_PAGE_ARG makes it the connect page's (src/preload/index.ts). */
const PRELOAD = join(here, '../preload/index.cjs');
const SERVERS_FILE = 'servers.json';
const CONNECT_SIZE = { width: 640, height: 640 } as const;

const servers = new ServerList(fileStore(profilePath(SERVERS_FILE)));
const windows = new ServerWindows(unreachable);
let connectWin: BrowserWindow | null = null;

/** The page that adds and picks servers; `unreachable` says which server didn't load, and why. */
function openConnect(unreachable?: { origin: string; reason: string }): void {
  if (!unreachable && connectWin && !connectWin.isDestroyed() && raiseWindow(connectWin)) return;
  connectWin?.close();
  const win = new BrowserWindow({ ...CONNECT_SIZE, show: false, autoHideMenuBar: true, title: 'Connect to a ChattyPop server', webPreferences: { preload: PRELOAD, additionalArguments: [CONNECT_PAGE_ARG], contextIsolation: true, sandbox: true, nodeIntegration: false } });
  connectWin = win;
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (connectWin === win) connectWin = null;
  });
  // It links nowhere: anything it would open goes to the system browser.
  guardNavigation(win.webContents, () => false);
  const query: Record<string, string> = unreachable ? { [CONNECT_UNREACHABLE_PARAMS.origin]: unreachable.origin, [CONNECT_UNREACHABLE_PARAMS.reason]: unreachable.reason } : {};
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) void win.loadURL(`${devUrl.replace(/\/$/, '')}/connect.html?${new URLSearchParams(query)}`);
  else void win.loadFile(join(here, '../renderer/connect.html'), { query });
}

/** Opens `origin`'s main window and keeps it as the server used last. */
function openServer(origin: string): void {
  servers.add(origin);
  windows.open(origin);
}

/** What opens when nothing names a server: the server used last, else the connect page. */
function openDefault(): void {
  const last = servers.last();
  if (last) windows.open(last);
  else openConnect();
}

/** A server window couldn't load: the connect page says why, and tries again or picks another server. */
function unreachable({ win, origin }: ServerWindow, reason: string): void {
  openConnect({ origin, reason });
  if (!win.isDestroyed()) win.close();
}

/** The connect page's calls; a call from any other window is refused. */
function registerConnectHandlers(): void {
  const fromConnect = (e: IpcMainInvokeEvent): void => {
    if (!connectWin || e.sender !== connectWin.webContents) throw new Error('Not the connect page.');
  };
  ipcMain.handle(CONNECT_CHANNELS.list, (e) => (fromConnect(e), servers.list()));
  ipcMain.handle(CONNECT_CHANNELS.add, (e, input: unknown) => (fromConnect(e), servers.add(String(input))));
  ipcMain.handle(CONNECT_CHANNELS.remove, (e, origin: unknown) => (fromConnect(e), servers.remove(String(origin))));
  ipcMain.handle(CONNECT_CHANNELS.open, (e, origin: unknown) => {
    fromConnect(e);
    const saved = servers.list().find((s) => s.origin === origin);
    if (!saved) throw new Error('Add the server first.');
    openServer(saved.origin);
    connectWin?.close();
  });
}

/** The client's menus: "Connect to a server…" beside the system's standard ones. Shown on Windows when Alt is pressed. */
function installClientMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(IS_MAC ? [{ role: 'appMenu' as const }] : []),
      { label: 'File', submenu: [{ label: 'Connect to a server…', accelerator: 'CmdOrCtrl+Shift+O', click: () => openConnect() }, { type: 'separator' }, { role: IS_MAC ? 'close' : 'quit' }] },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]), { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
      { role: 'windowMenu' },
    ]),
  );
}

void app.whenReady().then(() => {
  installClientMenu();
  registerShellHandlers(windows);
  registerConnectHandlers();
  const mode = launchMode(process.argv, process.env);
  if (mode.kind === 'client' && mode.origin) openServer(mode.origin);
  else openDefault();
});

// Launched again: open the server it names, else bring this client forward.
app.on('second-instance', (_e, argv) => {
  const mode = launchMode(argv, {});
  if (mode.kind === 'client' && mode.origin) return openServer(mode.origin);
  const front = windows.all()[0] ?? connectWin;
  if (front && !front.isDestroyed()) raiseWindow(front);
  else openDefault();
});
// macOS keeps an app running with no window; its dock icon opens one again.
app.on('window-all-closed', () => {
  if (!IS_MAC) app.quit();
});
app.on('activate', () => {
  if (!windows.all().length && !connectWin) openDefault();
});
