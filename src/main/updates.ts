// Checks public-release updates at startup and periodically; downloads in background and installs through graceful close. Dev runs skip updates.
import { app, type BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';
import type { UpdateStatus } from '@shared/desktop';
import { errorMessage } from '@shared/errors';
import { MS_PER_HOUR } from '@shared/units';
import { diag } from './diagnostics';
import { installOnRestart, restartApp } from './restart';

const { autoUpdater } = electronUpdater;

/** Releases are occasional: a few checks a day find one the day it ships without polling GitHub much. */
const CHECK_EVERY_MS = 6 * MS_PER_HOUR;

export class Updates {
  private status: UpdateStatus = app.isPackaged ? { phase: 'idle' } : { phase: 'unsupported' };

  /** `onChange` runs on each status change. */
  constructor(private readonly onChange: (status: UpdateStatus) => void) {
    if (!app.isPackaged) return;
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
    // Failures, the check's or the download's it starts, arrive as 'error' events too, which set the status.
    const result = await autoUpdater.checkForUpdates().catch(() => null);
    void result?.downloadPromise?.catch(() => undefined);
  }

  /** Restarts gracefully, which runs the downloaded installer; it starts ChattyPop again. */
  install(win: BrowserWindow): void {
    if (this.status.phase === 'ready') restartApp(win);
  }

  private set(status: UpdateStatus): void {
    this.status = status;
    this.onChange(status);
  }
}
