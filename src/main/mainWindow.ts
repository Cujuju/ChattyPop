import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, session, type BrowserWindowConstructorOptions } from 'electron';
import { DISCORD_OPEN_CHANNEL, DISCORD_SIDEBAR_CHANNEL, DISCORD_SLOT_CHANNEL, type DiscordSlot } from '@shared/contract';
import { normalizeDiscordSidebar } from '@shared/settings';
import { diag } from './diagnostics';
import { DISCORD_PARTITION, DiscordView } from './discordView';
import { guardNavigation } from './externalLinks';
import { WindowStateFile } from './windowState';

/** out/main: only index.ts imports this module, so it is bundled into out/main/index.js. */
const here = import.meta.dirname;
const PRELOAD = join(here, '../preload/index.cjs');
/** Where the main window was last placed and whether it was maximized, so it reopens that way. */
const mainWindowState = new WindowStateFile('main-window.json');
const MAIN_WINDOW_KEY = 'main';
/** First-run size, before any placement is saved. */
const MAIN_WINDOW_DEFAULT_SIZE = { width: 1440, height: 960 } as const;

/** The renderer never navigates or opens windows; its links (e.g. the Links feed) go to the system browser. */
function guardRenderer(win: BrowserWindow): void {
  // Same origin: dev-server reloads.
  guardNavigation(win.webContents, (url) => new URL(url).origin === new URL(win.webContents.getURL()).origin);
}

/** The unsaved-changes dialog's buttons, by index. */
const DISCARD_BUTTON = 0;
const KEEP_EDITING_BUTTON = 1;

/**
 * An editor with unsaved changes cancels the page's unload (beforeunload); the owner then picks whether the close
 * or reload goes ahead, rather than it being dropped silently.
 */
function askBeforeDiscarding(win: BrowserWindow): void {
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Discard changes', 'Keep editing'],
      defaultId: KEEP_EDITING_BUTTON,
      cancelId: KEEP_EDITING_BUTTON,
      noLink: true,
      title: 'Unsaved changes',
      message: 'Discard your unsaved changes?',
      detail: 'A rule you are editing in this window has changes you have not saved.',
    });
    if (choice === DISCARD_BUTTON) e.preventDefault(); // lets the unload go ahead
  });
}

/** Loads the app, or with `panel` just that panel (a panel window). */
export function loadRenderer(win: BrowserWindow, panel?: string): void {
  guardRenderer(win);
  askBeforeDiscarding(win);
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  const query = panel ? { panel } : undefined;
  if (devUrl) void win.loadURL(query ? `${devUrl}?${new URLSearchParams(query)}` : devUrl);
  else void win.loadFile(join(here, '../renderer/index.html'), query ? { query } : {});
}

/** The app icon file: in dev from build/, packaged beside the app (electron-builder extraResources), for the tray. */
export const appIconPath = (): string => (app.isPackaged ? join(process.resourcesPath, 'icon.ico') : join(app.getAppPath(), 'build', 'icon.ico'));

/** What every window showing the renderer shares: the app icon, no menu bar, the sandboxed preload. */
export function rendererWindowOptions(): BrowserWindowConstructorOptions {
  // Packaged builds take the icon from the exe; in dev it comes from build/ (not shipped inside the app).
  const devIcon = appIconPath();
  return {
    ...(!app.isPackaged && existsSync(devIcon) ? { icon: devIcon } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  };
}

/** Where minimizing and the window's own close command send the main window; read at each, so Settings apply at once. */
export interface TrayChoices {
  startHidden: boolean;
  minimizeToTray(): boolean;
  closeToTray(): boolean;
}

const WM_SYSCOMMAND = 0x0112;
const SC_CLOSE = 0xf060;
/** WM_SYSCOMMAND's low four bits are Windows' own; the command is the rest. */
const SYSCOMMAND_MASK = 0xfff0;

/** The WM_SYSCOMMAND command in a hooked message's wParam (pointer-sized). */
const sysCommand = (wParam: Buffer): number => (wParam.length >= 8 ? Number(wParam.readBigUInt64LE()) : wParam.readUInt32LE()) & SYSCOMMAND_MASK;

/** Graceful close unloads Discord to persist login. Only user window-close commands may hide to tray; programmatic/external WM_CLOSE quits. */
export function createMainWindow(tray: TrayChoices): { win: BrowserWindow; discord: DiscordView } {
  const saved = mainWindowState.get(MAIN_WINDOW_KEY);
  const win = new BrowserWindow({
    ...rendererWindowOptions(),
    ...(saved?.bounds ?? MAIN_WINDOW_DEFAULT_SIZE),
    show: false,
  });
  // Registered before the graceful-close handler below, so its save runs first on each close event.
  mainWindowState.manage(win, MAIN_WINDOW_KEY, saved, { startHidden: tray.startHidden });
  loadRenderer(win);

  const discord = new DiscordView(win);
  const onSlot = (e: Electron.IpcMainEvent, slot: DiscordSlot): void => {
    if (e.sender === win.webContents) discord.setSlot(slot);
  };
  const onSidebar = (e: Electron.IpcMainEvent, sidebar: unknown): void => {
    if (e.sender === win.webContents) discord.setSidebar(normalizeDiscordSidebar(sidebar));
  };
  const onOpenChannel = (e: Electron.IpcMainEvent, guildId: unknown, channelId: unknown): void => {
    if (e.sender === win.webContents && typeof guildId === 'string' && typeof channelId === 'string') discord.openChannel(guildId, channelId);
  };
  ipcMain.on(DISCORD_SLOT_CHANNEL, onSlot);
  ipcMain.on(DISCORD_SIDEBAR_CHANNEL, onSidebar);
  ipcMain.on(DISCORD_OPEN_CHANNEL, onOpenChannel);
  win.on('closed', () => {
    ipcMain.off(DISCORD_SLOT_CHANNEL, onSlot);
    ipcMain.off(DISCORD_SIDEBAR_CHANNEL, onSidebar);
    ipcMain.off(DISCORD_OPEN_CHANNEL, onOpenChannel);
  });

  // Closing the window destroys the Discord view without unloading its page, which loses the login.
  // Hold the close until the page has unloaded and its storage is flushed to disk.
  let discordClosed = false;
  /** The graceful close in flight: a second close request (double-click, a repeated WM_CLOSE) waits on it. */
  let closing: Promise<void> | null = null;
  // A page's beforeunload handler can cancel a close before 'close' fires; log it, since it looks like an ignored close.
  win.webContents.on('will-prevent-unload', () => diag('renderer-prevented-unload'));
  // Set by SC_CLOSE, which Windows turns into WM_CLOSE (the 'close' below) before the hook returns.
  let closeCommand = false;
  win.hookWindowMessage(WM_SYSCOMMAND, (wParam) => {
    if (sysCommand(wParam) !== SC_CLOSE) return;
    closeCommand = true;
    // Refused close commands must not classify later programmatic closes as owner commands.
    setImmediate(() => (closeCommand = false));
  });
  win.on('minimize', () => {
    if (tray.minimizeToTray()) win.hide();
  });
  win.on('close', (e) => {
    const toTray = closeCommand && tray.closeToTray();
    closeCommand = false;
    diag('window-close', { discordClosed, toTray });
    if (toTray) {
      e.preventDefault();
      win.hide();
      return;
    }
    if (discordClosed) return;
    e.preventDefault();
    closing ??= discord.closeGracefully().then(() => {
      discordClosed = true;
      session.fromPartition(DISCORD_PARTITION).flushStorageData();
      if (!win.isDestroyed()) win.close();
    });
  });
  // Delays Windows session termination while graceful close preserves Discord login; shutdown continues after ChattyPop exits.
  win.on('query-session-end', (e) => {
    diag('session-end-query', { reasons: e.reasons, discordClosed });
    if (discordClosed) return;
    // A critical shutdown can't wait; the close still starts, and 'session-end' flushes what it can.
    if (!e.reasons.includes('critical')) e.preventDefault();
    win.close();
  });
  // The session ends now (forced, or the owner chose "Shut down anyway"): save what storage holds.
  win.on('session-end', () => {
    diag('session-end', { discordClosed });
    session.fromPartition(DISCORD_PARTITION).flushStorageData();
  });
  return { win, discord };
}
