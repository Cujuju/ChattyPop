// The startup splash: shows at once, marks startup steps as they finish and closes when the main window first shows.
// It replaces a dev launcher's splash (scripts/dev.mjs), which shows the same page while the app builds.
import { join } from 'node:path';
import { app, ipcMain, type BrowserWindow } from 'electron';
import { MAIN_INVOKE } from '@shared/contract';
import { SPLASH_SHOWN_MESSAGE, SPLASH_THEME_FILE, type SplashPhaseId } from '@shared/splash.mjs';
import { openSplash, readSplashTheme, writeSplashTheme } from './splashWindow.mjs';
import { profilePath } from './storageLocation';

/** out/main, beside out/renderer where the build puts the splash page. */
const here = import.meta.dirname;
const dev = (): boolean => !!process.env['ELECTRON_RENDERER_URL'];

/** In dev, the source page: the dev server may still be busy transforming the app when this loads. */
const splashPage = (): string => (dev() ? join(app.getAppPath(), 'src/renderer/splash.html') : join(here, '../renderer/splash.html'));

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
  // In dev the launcher built the app before starting it.
  const splash = openSplash({ page: splashPage(), theme: readSplashTheme(profilePath(SPLASH_THEME_FILE)), dev: dev(), done: dev() ? ['build'] : [] });
  void splash.shown.then(releaseLauncherSplash);
  const close = (): void => {
    releaseLauncherSplash();
    splash.close();
  };
  main.once('show', close);
  main.once('closed', close);
  return splash;
}
