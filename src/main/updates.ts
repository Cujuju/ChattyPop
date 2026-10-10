// Checks public-release updates at startup and periodically; downloads in background and installs through graceful close. Dev runs skip updates.
// Windows uses electron-updater and its installer; macOS, whose builds carry no Apple signature, its own (macUpdate.ts).
import { app, net, type BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';
import type { UpdateStatus } from '@shared/desktop';
import { errorMessage } from '@shared/errors';
import { MS_PER_HOUR } from '@shared/units';
import { diag } from './diagnostics';
import { installStaged, MacUpdater, UPDATES_DIR, type StagedUpdate } from './macUpdate';
import { IS_MAC } from './platform';
import { installOnRestart, restartApp } from './restart';
import { profilePath } from './storageLocation';

const { autoUpdater } = electronUpdater;

/** Releases are occasional: a few checks a day find one the day it ships without polling GitHub much. */
const CHECK_EVERY_MS = 6 * MS_PER_HOUR;
/** The public repo whose releases are the updates (electron-builder.ts publishes there). */
const RELEASE_REPO = 'Cujuju/ChattyPop';

export class Updates {
  private status: UpdateStatus = app.isPackaged ? { phase: 'idle' } : { phase: 'unsupported' };
  /** macOS' updater; undefined on other systems and in dev. */
  private mac: MacUpdater | undefined;
  /** The update macOS has unpacked, waiting for a quit to swap it in. */
  private staged: StagedUpdate | undefined;
  /** The quit under way is a restart: the installed update opens again. */
  private reopen = false;

  /** `onChange` runs on each status change. */
  constructor(private readonly onChange: (status: UpdateStatus) => void) {
    if (!app.isPackaged) return;
    if (IS_MAC) {
      this.mac = new MacUpdater({
        repo: RELEASE_REPO,
        currentVersion: app.getVersion(),
        arch: process.arch,
        exe: process.execPath,
        dir: profilePath(UPDATES_DIR),
        fetch: (url) => net.fetch(url),
        onProgress: (percent) => {
          if (this.status.phase === 'downloading') this.set({ ...this.status, percent });
        },
      });
      // A quit with an update staged installs it without starting again; a restart (installOnRestart, at 'will-quit') has it reopen.
      // At 'quit', after every 'will-quit' listener: one swap starts, knowing which it is.
      app.on('quit', () => {
        if (this.staged) installStaged(this.staged, this.reopen);
      });
      void this.check();
      setInterval(() => void this.check(), CHECK_EVERY_MS);
      return;
    }
    // A quit with an update downloaded installs it (silently, without starting again); a restart, through installOnRestart.
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => this.set({ phase: 'checking' }));
    autoUpdater.on('update-not-available', () => this.set({ phase: 'current' }));
    autoUpdater.on('update-available', (info) => this.set({ phase: 'downloading', version: info.version, percent: 0 }));
    autoUpdater.on('download-progress', (p) => {
      const percent = Math.floor(p.percent);
      // Progress arrives many times a second; windows hear of whole-percent steps only.
      if (this.status.phase === 'downloading' && percent !== this.status.percent) this.set({ ...this.status, percent });
    });
    autoUpdater.on('update-downloaded', (info) => {
      installOnRestart(() => autoUpdater.quitAndInstall(true, true));
      this.set({ phase: 'ready', version: info.version });
    });
    autoUpdater.on('error', (err) => {
      diag('update-failed', { message: errorMessage(err) });
      this.set({ phase: 'failed', message: errorMessage(err) });
    });
    void this.check();
    setInterval(() => void this.check(), CHECK_EVERY_MS);
  }

  current(): UpdateStatus {
    return this.status;
  }

  /** Looks for a newer release; nothing while one is being checked, downloaded or waits to be installed. */
  async check(): Promise<void> {
    if (['unsupported', 'checking', 'downloading', 'ready'].includes(this.status.phase)) return;
    if (this.mac) return this.checkMac(this.mac);
    // Failures, the check's or the download's it starts, arrive as 'error' events too, which set the status.
    const result = await autoUpdater.checkForUpdates().catch(() => null);
    void result?.downloadPromise?.catch(() => undefined);
  }

  /** Restarts gracefully, which runs the downloaded installer; it starts ChattyPop again. */
  install(win: BrowserWindow): void {
    if (this.status.phase === 'ready') restartApp(win);
  }

  private async checkMac(mac: MacUpdater): Promise<void> {
    this.set({ phase: 'checking' });
    try {
      const found = await mac.newer();
      if (!found) return this.set({ phase: 'current' });
      this.set({ phase: 'downloading', version: found.version, percent: 0 });
      const staged = await mac.stage(found.version, found.file);
      this.staged = staged;
      installOnRestart(() => void (this.reopen = true));
      this.set({ phase: 'ready', version: found.version });
    } catch (err) {
      diag('update-failed', { message: errorMessage(err) });
      this.set({ phase: 'failed', message: errorMessage(err) });
    }
  }

  private set(status: UpdateStatus): void {
    this.status = status;
    this.onChange(status);
  }
}
