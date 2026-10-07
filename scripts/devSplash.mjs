// Electron entry scripts/dev.mjs starts before anything builds: the startup splash, until the app shows its own
// (src/main/splash.ts) and dev.mjs ends this process.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import splash from '../src/shared/splash.json' with { type: 'json' };

// Its own throwaway profile, not the app's or a shared "Electron" one.
app.setPath('userData', join(tmpdir(), 'chattypop-dev-splash'));
void app.whenReady().then(() => {
  const win = new BrowserWindow({ ...splash.window, show: false });
  win.once('ready-to-show', () => win.show());
  void win.loadFile(join(import.meta.dirname, '../src/renderer/splash.html'));
});
