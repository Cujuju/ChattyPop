// Settings → Desktop in main: the settings file, Windows' sign-in start, the show/hide hotkey, the tray and updates.
import { readFileSync, writeFileSync } from 'node:fs';
import { app, globalShortcut, ipcMain, type BrowserWindow } from 'electron';
import { MAIN_INVOKE, type AppEvent } from '@shared/contract';
import { DEFAULT_DESKTOP_SETTINGS, indicatedUnread, normalizeDesktopSettings, type DesktopSettings, type DesktopState } from '@shared/desktop';
import { NO_UNREAD, normalizeUnreadTotals, type UnreadTotals } from '@shared/unread';
import { errorMessage } from '@shared/errors';
import { diag } from './diagnostics';
import { appIconPath } from './mainWindow';
import { profilePath } from './storageLocation';
import { AppTray } from './tray';
import { Updates } from './updates';
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

/** Reports Windows sign-in startup; null for dev runs. */
function openAtLogin(): boolean | null {
  if (!app.isPackaged) return null;
  // Windows' Startup apps switch can turn the entry off without removing it.
  return app.getLoginItemSettings({ args: [AT_LOGIN_ARG] }).executableWillLaunchAtLogin;
}

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
  private toMain: (e: AppEvent) => void = () => {};

  /** Whether this start stays in the tray: Windows started it at sign-in and the owner chose that. */
  readonly startHidden = process.argv.includes(AT_LOGIN_ARG) && this.settings.startHidden;
  readonly minimizeToTray = (): boolean => this.settings.minimizeToTray;
  readonly closeToTray = (): boolean => this.settings.closeToTray;

  /** Adds the tray, hotkey and updates for the main window; `toMain` carries state changes to it. */
  attach(win: BrowserWindow, toMain: (e: AppEvent) => void): void {
    this.win = win;
    this.toMain = toMain;
    this.tray = new AppTray(win, appIconPath(), {
      open: () => raiseWindow(win),
      installUpdate: () => this.updates?.install(win),
      // A close from code, not the window's own close command, so it quits rather than going to the tray.
      quit: () => win.close(),
    });
    this.updates = new Updates((status) => {
      this.tray?.setUpdate(status.phase === 'ready' ? status.version : null);
      this.changed();
    });
    this.bindHotkey();
    app.on('will-quit', () => globalShortcut.unregisterAll());
    this.registerHandlers();
  }

  private state(): DesktopState {
    return {
      settings: this.settings,
      openAtLogin: openAtLogin(),
      hotkeyTaken: this.hotkeyTaken,
      update: this.updates?.current() ?? { phase: 'unsupported' },
      version: __APP_VERSION__,
    };
  }

  private changed(): void {
    this.toMain({ type: 'desktop-changed', state: this.state() });
  }

  private set(patch: Partial<DesktopSettings>): void {
    this.settings = normalizeDesktopSettings({ ...this.settings, ...patch });
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
    // `enabled` also sets Windows' Startup apps switch, which may have turned the entry off.
    app.setLoginItemSettings({ openAtLogin: on, enabled: on, args: [AT_LOGIN_ARG], name: LOGIN_ITEM_NAME });
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
    ipcMain.handle(desktop.state, () => this.state());
    ipcMain.handle(desktop.set, (_e, patch: unknown) => this.set(normalizeDesktopSettings({ ...this.settings, ...(patch as object) })));
    ipcMain.handle(desktop.setOpenAtLogin, (_e, on: unknown) => this.setOpenAtLogin(on === true));
    ipcMain.handle(desktop.setBadge, (e, unread: unknown) => {
      // The main window's own totals; panel windows hold copies of the same stores.
      if (e.sender !== this.win?.webContents) return;
      this.unread = normalizeUnreadTotals(unread);
      this.showUnread();
    });
    ipcMain.handle(desktop.checkForUpdate, () => this.updates?.check());
    ipcMain.handle(desktop.installUpdate, () => this.win && this.updates?.install(this.win));
  }
}
