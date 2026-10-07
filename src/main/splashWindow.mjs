// Opens the startup splash and drives it: theme, status and progress. Plain JS: the dev launcher's splash process
// (scripts/devSplash.mjs) runs it before anything builds; the app's splash (splash.ts) runs the same code.
import { readFileSync, writeFileSync } from 'node:fs';
import { BrowserWindow } from 'electron';
import { SPLASH_PHASES, SPLASH_THEME_TOKENS, SPLASH_WINDOW } from '../shared/splash.mjs';

/** Longer than any colour or keyword a token resolves to. */
const MAX_TOKEN_VALUE_LENGTH = 200;
/** Colours and keywords only: no url(), quotes, escapes or declaration breaks. */
const TOKEN_VALUE = /^[\w#(),.%\s/-]+$/;

/** Theme as stored or sent: the known tokens with plausible values; null when none are. */
export function normalizeSplashTheme(v) {
  if (!v || typeof v !== 'object') return null;
  const theme = Object.fromEntries(
    SPLASH_THEME_TOKENS.flatMap((t) => {
      const value = v[t];
      return typeof value === 'string' && value.length <= MAX_TOKEN_VALUE_LENGTH && TOKEN_VALUE.test(value) && !/url\(/i.test(value) ? [[t, value]] : [];
    }),
  );
  return Object.keys(theme).length ? theme : null;
}

/** The saved theme; null on a first run or an unreadable file (the splash keeps its default look). */
export function readSplashTheme(file) {
  try {
    return normalizeSplashTheme(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

/** Saves `theme` unless it is invalid or unchanged. */
export function writeSplashTheme(file, theme) {
  const next = normalizeSplashTheme(theme);
  if (!next || JSON.stringify(next) === JSON.stringify(readSplashTheme(file))) return;
  writeFileSync(file, JSON.stringify(next));
}

/** Runs in the splash page (serialized): wears the theme, status and progress, then waits for them to paint. */
function wear(state) {
  const root = document.documentElement;
  for (const [token, value] of Object.entries(state.theme ?? {})) root.style.setProperty(token, value);
  document.getElementById('splash-status').textContent = state.status;
  const bar = document.getElementById('splash-progress');
  bar.setAttribute('aria-valuemax', String(state.total));
  bar.setAttribute('aria-valuenow', String(state.done));
  bar.style.setProperty('--splash-done', String(state.done / state.total));
  return new Promise((painted) => requestAnimationFrame(() => requestAnimationFrame(() => painted())));
}

/** Opens the splash on `page`, shown once it wears its state (no default-look flash). `dev` adds the build step. */
export function openSplash({ page, theme, dev, done = [] }) {
  const phases = SPLASH_PHASES.filter((p) => dev || !p.devOnly);
  const finished = new Set(done);
  const win = new BrowserWindow({ ...SPLASH_WINDOW, show: false });
  const state = () => ({
    theme,
    status: (phases.find((p) => !finished.has(p.id)) ?? phases[phases.length - 1]).label,
    done: phases.filter((p) => finished.has(p.id)).length,
    total: phases.length,
  });
  const render = () => (win.isDestroyed() ? Promise.resolve() : win.webContents.executeJavaScript(`(${wear})(${JSON.stringify(state())})`).catch(() => undefined));
  let loaded = false;
  const shown = new Promise((resolve) => {
    win.webContents.once('did-finish-load', () => {
      loaded = true;
      void render().then(() => {
        if (!win.isDestroyed()) win.show();
        resolve();
      });
    });
  });
  void win.loadFile(page);
  return {
    /** Settles once the splash is on screen. */
    shown,
    /** Marks a step done. */
    finish(id) {
      finished.add(id);
      if (loaded) void render();
    },
    close() {
      if (!win.isDestroyed()) win.close();
    },
  };
}
