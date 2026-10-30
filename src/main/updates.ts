// Stable or nightly updates (@cujuju/electron-updates), the same path on every OS. Downloads in the background;
// any quit installs a downloaded update, and a restart reopens it. Dev runs skip updates.
import { app, net, type BrowserWindow } from 'electron';
import { createUpdater, type Updater, type UpdateStatus } from '@cujuju/electron-updates';
import { UPDATE_REPO, UPDATE_SIGNATURE_CONTEXT, type UpdateChannel } from '@shared/updateFeed';
import { diag } from './diagnostics';
import { installOnRestart, restartApp } from './restart';
import { profilePath } from './storageLocation';

/** The folder in the app profile the updater owns. */
const UPDATES_DIR = 'updates';

export class Updates {
  private readonly updater: Updater;

  /** `channel` is read at each check; `onChange` runs on each status change. */
  constructor(channel: () => UpdateChannel, onChange: (status: UpdateStatus) => void) {
    this.updater = createUpdater({
      app,
      appName: 'ChattyPop',
      repo: UPDATE_REPO,
      publicKey: __UPDATE_PUBLIC_KEY__,
      signatureContext: UPDATE_SIGNATURE_CONTEXT,
      channel,
      dir: profilePath(UPDATES_DIR),
      fetch: (url, init) => net.fetch(url, init),
      autoDownload: true,
      installOnQuit: true,
    });
    this.updater.on('status', (status) => {
      if (status.state === 'error') diag('update-failed', { message: status.message });
      // A restart (restart.ts, at 'will-quit') reopens the app after installing.
      if (status.state === 'ready') installOnRestart(() => this.updater.installOnQuit(true));
      onChange(status);
    });
    this.updater.setAutoCheck(true);
  }

  current(): UpdateStatus {
    return this.updater.status();
  }

  /** Looks for a newer release; nothing while one is being checked, downloaded or waits to be installed. */
  check(): Promise<void> {
    return this.updater.check();
  }

  /** Restarts gracefully, which installs the downloaded update and starts ChattyPop again. */
  install(win: BrowserWindow): void {
    if (this.updater.status().state === 'ready') restartApp(win);
  }
}
