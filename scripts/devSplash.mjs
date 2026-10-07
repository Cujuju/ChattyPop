// Electron entry scripts/dev.mjs starts before anything builds: the startup splash, marked by the steps dev.mjs sends,
// until the app shows its own (src/main/splash.ts) and dev.mjs ends this process.
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import { openSplash, readSplashTheme } from '../src/main/splashWindow.mjs';
import { SPLASH_THEME_FILE } from '../src/shared/splash.mjs';

const root = join(import.meta.dirname, '..');
/** The app's profile in dev: CHATTYPOP_PROFILE_DIR when set (main/storageLocation.ts), else Electron's default for the package name. */
const profileDir = process.env.CHATTYPOP_PROFILE_DIR || join(app.getPath('appData'), JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name);
// Its own throwaway profile, not the app's or a shared "Electron" one.
app.setPath('userData', join(tmpdir(), 'chattypop-dev-splash'));

/** Steps dev.mjs finished before the window opened. */
const early = [];
let splash = null;
process.on('message', (id) => (splash ? splash.finish(id) : early.push(id)));
void app.whenReady().then(() => {
  splash = openSplash({ page: join(root, 'src/renderer/splash.html'), theme: readSplashTheme(join(profileDir, SPLASH_THEME_FILE)), dev: true, done: early });
});
