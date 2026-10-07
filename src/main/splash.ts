// The startup splash: shows at once, marks startup steps as they finish and closes when the main window first shows.
// It replaces a dev launcher's splash (scripts/dev.mjs), which shows the same page while the app builds.
import { join } from 'node:path';
import { app, ipcMain, type BrowserWindow } from 'electron';
import { MAIN_INVOKE } from '@shared/contract';
import { errorMessage } from '@shared/errors';
import { DEV_LAUNCH_ENV, SPLASH_SHOWN_MESSAGE, SPLASH_THEME_FILE, SPLASH_TIMELINE_FILE, type SplashPhaseId, type SplashSteps } from '@shared/splash.mjs';
import { diag } from './diagnostics';
import { openSplash, readSplashTheme, readSplashTimeline, writeSplashTheme, writeSplashTimeline } from './splashWindow.mjs';
import { profilePath } from './storageLocation';

/** out/main, beside out/renderer where the build puts the splash page. */
const here = import.meta.dirname;
const dev = (): boolean => !!process.env['ELECTRON_RENDERER_URL'];

/** In dev, the source page: the dev server may still be busy transforming the app when this loads. */
const splashPage = (): string => (dev() ? join(app.getAppPath(), 'src/renderer/splash.html') : join(here, '../renderer/splash.html'));

/** What the dev launcher (scripts/dev.mjs) passed: its start and the steps it finished, epoch ms. */
interface DevLaunch {
  start: number;
  done: SplashSteps;
}

function devLaunch(): DevLaunch | null {
  try {
    const v = JSON.parse(process.env[DEV_LAUNCH_ENV] ?? 'null') as Partial<DevLaunch> | null;
    return v && Number.isFinite(v.start) && v.done && typeof v.done === 'object' ? (v as DevLaunch) : null;
  } catch {
    return null;
  }
}

/** Tells a launcher that spawned the app (scripts/dev.mjs) to close its splash; once. */
let launcherReleased = false;
function releaseLauncherSplash(): void {
  if (launcherReleased) return;
  launcherReleased = true;
  process.send?.(SPLASH_SHOWN_MESSAGE);
}

export interface StartupSplash {
  /** Marks a startup step done. */
  finish(id: SplashPhaseId): void;
}

/** Shows the splash until `main` first shows or closes; a start hidden in the tray shows none. Wears the theme the main window last saved. */
export function startSplash(main: BrowserWindow, startHidden: boolean): StartupSplash {
  // The main window saves the theme's splash tokens each time it wears a theme (state/desktop.ts).
  ipcMain.handle(MAIN_INVOKE.desktop.setSplashTheme, (e, theme: unknown) => {
    if (e.sender === main.webContents) writeSplashTheme(profilePath(SPLASH_THEME_FILE), theme);
  });
  if (startHidden) {
    releaseLauncherSplash();
    return { finish: () => undefined };
  }
  // In dev the launcher built the app before starting it, and its start begins the launch; else this process's start does.
  const launch = dev() ? devLaunch() : null;
  const start = launch?.start ?? performance.timeOrigin;
  const timelineFile = profilePath(SPLASH_TIMELINE_FILE);
  const splash = openSplash({
    page: splashPage(),
    theme: readSplashTheme(profilePath(SPLASH_THEME_FILE)),
    dev: dev(),
    last: readSplashTimeline(timelineFile, dev())?.steps,
    start,
    // This process is up: the app step ends as its splash opens.
    done: { ...(launch?.done ?? (dev() ? { compile: start, build: start } : {})), app: Date.now() },
  });
  // The next launch places its steps by this one. A dev start without the launcher has no build time to save.
  if (!dev() || launch) {
    void splash.complete
      .then((steps) => writeSplashTimeline(timelineFile, dev(), { steps }))
      .catch((err: unknown) => diag('splash-timeline-save-failed', { message: errorMessage(err) }));
  }
  void splash.shown.then(releaseLauncherSplash);
  const close = (): void => {
    releaseLauncherSplash();
    splash.close();
  };
  main.once('show', () => {
    splash.finish('window');
    close();
  });
  main.once('closed', close);
  return splash;
}
