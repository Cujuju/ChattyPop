// The startup splash: shows at once and closes when the main window first shows. It replaces a dev launcher's splash
// (scripts/dev.mjs), which shows the same page while the app builds.
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import splash from '@shared/splash.json';

/** out/main, beside out/renderer where the build puts the splash page. */
const here = import.meta.dirname;

/** In dev, the source page: the dev server may still be busy transforming the app when this loads. */
const splashPage = (): string =>
  process.env['ELECTRON_RENDERER_URL'] ? join(app.getAppPath(), 'src/renderer/splash.html') : join(here, '../renderer/splash.html');

/** Tells a launcher that spawned the app (scripts/dev.mjs) to close its splash; once. */
let launcherReleased = false;
function releaseLauncherSplash(): void {
  if (launcherReleased) return;
  launcherReleased = true;
  process.send?.(splash.shownMessage);
}

/** Shows the splash until `main` first shows or closes. A start hidden in the tray shows none. */
export function showSplashUntilShown(main: BrowserWindow, startHidden: boolean): void {
  if (startHidden) return releaseLauncherSplash();
  const win = new BrowserWindow({ ...splash.window, show: false });
  win.once('ready-to-show', () => {
    win.show();
    releaseLauncherSplash();
  });
  void win.loadFile(splashPage());
  const close = (): void => {
    releaseLauncherSplash();
    if (!win.isDestroyed()) win.close();
  };
  main.once('show', close);
  main.once('closed', close);
}
