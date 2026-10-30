// Settings → Desktop in main: the settings file, Windows' sign-in start, the show/hide hotkey, the tray and updates.
import { readFileSync, writeFileSync } from 'node:fs';
import { app, globalShortcut, ipcMain, type BrowserWindow } from 'electron';
import { handleMain } from './ipc/mainCalls';
import { MAIN_INVOKE, type AppEvent } from '@shared/contract';
import { DEFAULT_DESKTOP_SETTINGS, desktopPlatform, indicatedUnread, normalizeDesktopSettings, NO_UPDATER, type DesktopSettings, type DesktopState } from '@shared/desktop';
import { NO_UNREAD, normalizeUnreadTotals, type UnreadTotals } from '@shared/unread';
import { errorMessage } from '@shared/errors';
import { diag } from './diagnostics';
import { appIconPath } from './mainWindow';
import { IS_WINDOWS } from './platform';
import { restartApp } from './restart';
import { profilePath } from './storageLocation';
import { AppTray } from './tray';
import { Updates } from './updates';
import { closeFromCode } from './windowClose';
import { raiseWindow } from './windowState';

/** In the app profile, not the archive: these apply before core opens it, and when it can't. */
const SETTINGS_FILE = 'desktop.json';
/** Passed by Windows' sign-in entry, so a start at sign-in can stay in the tray. */
const AT_LOGIN_ARG = '--at-login';
/** The sign-in entry's registry value name; build/installer.nsh removes it on uninstall. */
const LOGIN_ITEM_NAME = 'ChattyPop';

function readSettings(): DesktopSettings {
  try {
    return normalizeDesktopSettings(JSON.parse(readFileSync(profilePath(SETTINGS_FILE), 'utf8')));
  } catch {
    return DEFAULT_DESKTOP_SETTINGS; // first start, or an unreadable file
  }
}

/** Reports whether the system starts the app at sign-in; null for dev runs. */
function openAtLogin(): boolean | null {
  if (!app.isPackaged) return null;
  // Windows' Startup apps switch can turn the entry off without removing it.
  if (IS_WINDOWS) return app.getLoginItemSettings({ args: [AT_LOGIN_ARG] }).executableWillLaunchAtLogin;
  return app.getLoginItemSettings().openAtLogin;
}

/** Whether the system started this run at sign-in. Windows passes the entry's argument; macOS entries take none, and it says so itself. */
const startedAtLogin = (): boolean => process.argv.includes(AT_LOGIN_ARG) || (!IS_WINDOWS && app.getLoginItemSettings().wasOpenedAtLogin);

export class Desktop {
  private settings = readSettings();
  /** The hotkey bound now, so a change can unbind it. */
  private bound: string | null = null;
  private hotkeyTaken = false;
  /** The main window's unread totals, before the owner's indicator choices apply. */
  private unread: UnreadTotals = NO_UNREAD;
  private tray: AppTray | undefined;
  private updates: Updates | undefined;
  private win: BrowserWindow | undefined;
  private emit: (e: AppEvent) => void = () => {};

  /** Whether this start stays in the tray: a server's always; else the system started it at sign-in and the owner chose that. */
  readonly startHidden: boolean;
  readonly minimizeToTray = (): boolean => this.settings.minimizeToTray;
  readonly closeToTray = (): boolean => this.serverMode || this.settings.closeToTray;

  /** Server mode (--server): the window starts hidden and closes to the tray; ChattyPop runs until Quit. */
  constructor(private readonly serverMode = false) {
    this.startHidden = serverMode || (startedAtLogin() && this.settings.startHidden);
  }

  /**
   * Adds the tray, hotkey and updates for the main window; `emit` carries state changes to every window and the phone.
   * `pair` (server mode) adds the tray's "Pair a device…".
   */
  attach(win: BrowserWindow, emit: (e: AppEvent) => void, pair?: () => void): void {
    this.win = win;
    this.emit = emit;
    this.tray = new AppTray(win, appIconPath(), {
      open: () => raiseWindow(win),
      // Installs a downloaded update on the way (restart.ts).
      restart: () => restartApp(win),
      // A close from code, not the window's own close command, so it quits rather than going to the tray.
      quit: () => closeFromCode(win),
      ...(pair ? { pair } : {}),
    });
    this.updates = new Updates(() => this.settings.updateChannel, (status) => {
      this.tray?.setUpdate(status.state === 'ready' ? status.version : null);
      this.changed();
    });
    this.bindHotkey();
    app.on('will-quit', () => globalShortcut.unregisterAll());
    this.registerHandlers();
  }

  private state(): DesktopState {
    return {
      platform: desktopPlatform(process.platform),
      settings: this.settings,
      openAtLogin: openAtLogin(),
      hotkeyTaken: this.hotkeyTaken,
      update: this.updates?.current() ?? NO_UPDATER,
      version: __APP_VERSION__,
    };
  }

  private changed(): void {
    this.emit({ type: 'desktop-changed', state: this.state() });
  }

  private set(patch: Partial<DesktopSettings>): void {
    const channel = this.settings.updateChannel;
    this.settings = normalizeDesktopSettings({ ...this.settings, ...patch });
    if (this.settings.updateChannel !== channel) void this.updates?.check();
    try {
      writeFileSync(profilePath(SETTINGS_FILE), JSON.stringify(this.settings));
    } catch (err) {
      diag('desktop-settings-save-failed', { message: errorMessage(err) });
    }
    this.bindHotkey();
    this.showUnread();
    this.changed();
  }

  private showUnread(): void {
    this.tray?.setUnread(indicatedUnread(this.unread, this.settings));
  }

  private setOpenAtLogin(on: boolean): void {
    if (!app.isPackaged) throw new Error('Starting at sign-in needs an installed ChattyPop.');
    // `enabled` also sets Windows' Startup apps switch, which may have turned the entry off. Only Windows' entries carry arguments and a name.
    app.setLoginItemSettings(IS_WINDOWS ? { openAtLogin: on, enabled: on, args: [AT_LOGIN_ARG], name: LOGIN_ITEM_NAME } : { openAtLogin: on });
    this.changed();
  }

  /** Shows the main window, or hides it to the tray when it is the one in front. */
  private toggleWindow(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    if (win.isVisible() && !win.isMinimized() && win.isFocused()) win.hide();
    else raiseWindow(win);
  }

  private bindHotkey(): void {
    const wanted = this.settings.hotkey;
    if (wanted === this.bound && !this.hotkeyTaken) return;
    if (this.bound) globalShortcut.unregister(this.bound);
    this.bound = null;
    this.hotkeyTaken = false;
    if (!wanted) return;
    // False when another app holds the shortcut.
    if (globalShortcut.register(wanted, () => this.toggleWindow())) this.bound = wanted;
    else this.hotkeyTaken = true;
  }

  private registerHandlers(): void {
    const { desktop } = MAIN_INVOKE;
    handleMain(desktop.state, () => this.state());
    handleMain(desktop.set, (patch) => this.set(normalizeDesktopSettings({ ...this.settings, ...(patch as object) })));
    handleMain(desktop.setOpenAtLogin, (on) => this.setOpenAtLogin(on === true));
    ipcMain.handle(desktop.setBadge, (e, unread: unknown) => {
      // The main window's own totals; panel windows hold copies of the same stores.
      if (e.sender !== this.win?.webContents) return;
      this.unread = normalizeUnreadTotals(unread);
      this.showUnread();
    });
    handleMain(desktop.checkForUpdate, () => this.updates?.check());
    handleMain(desktop.installUpdate, () => this.win && this.updates?.install(this.win));
  }
}
