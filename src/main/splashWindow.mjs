// Opens the startup splash and drives it: theme, status and progress. Plain JS: the dev launcher's splash process
// (scripts/devSplash.mjs) runs it before anything builds; the app's splash (splash.ts) runs the same code.
import { readFileSync, writeFileSync } from 'node:fs';
import { BrowserWindow } from 'electron';
import { SPLASH_PHASES, SPLASH_THEME_TOKENS, SPLASH_WINDOW, splashProgress } from '../shared/splash.mjs';

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

/** One mode's timeline as stored: known steps with finite non-negative times; null when it holds none. */
function normalizeTimeline(v) {
  if (!v || typeof v !== 'object') return null;
  const steps = Object.fromEntries(SPLASH_PHASES.flatMap(({ id }) => (Number.isFinite(v.steps?.[id]) && v.steps[id] >= 0 ? [[id, v.steps[id]]] : [])));
  return Object.keys(steps).length ? { steps } : null;
}

const timelineMode = (dev) => (dev ? 'dev' : 'release');

function readTimelines(file) {
  try {
    const all = JSON.parse(readFileSync(file, 'utf8'));
    return all && typeof all === 'object' ? all : {};
  } catch {
    return {};
  }
}

/** The last launch's timeline for the mode; null on a first run or an unreadable file (the splash spaces steps evenly). */
export function readSplashTimeline(file, dev) {
  return normalizeTimeline(readTimelines(file)[timelineMode(dev)]);
}

/** Saves the mode's timeline, keeping the other mode's. */
export function writeSplashTimeline(file, dev, timeline) {
  const next = normalizeTimeline(timeline);
  if (next) writeFileSync(file, JSON.stringify({ ...readTimelines(file), [timelineMode(dev)]: next }));
}

/** Runs in the splash page (serialized): wears the theme, status and bar (theme/splash.css), then waits for them to paint. */
function wear(state) {
  const root = document.documentElement;
  for (const [token, value] of Object.entries(state.theme ?? {})) root.style.setProperty(token, value);
  // Loops start here, phased to the launch start: the launcher's splash and the app's, which replaces it, stay in step.
  if (!root.hasAttribute('data-splash-clock')) {
    root.style.setProperty('--splash-clock', `${state.start - Date.now()}ms`);
    root.setAttribute('data-splash-clock', '');
  }
  // Transitions run from here on: never from the page's initial empty bar.
  root.toggleAttribute('data-splash-live', state.live);
  document.getElementById('splash-status').textContent = state.status;
  const bar = document.getElementById('splash-progress');
  // Percent: aria-valuemin is 0 in the page.
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-valuenow', String(Math.round(state.at * 100)));
  bar.style.setProperty('--splash-done', String(state.at));
  bar.style.setProperty('--splash-glide', String(state.toward));
  bar.style.setProperty('--splash-glide-ms', `${state.over}ms`);
  return new Promise((painted) => requestAnimationFrame(() => requestAnimationFrame(() => painted())));
}

/**
 * Opens the splash on `page`, shown once it wears its state (no default-look flash). `dev` adds the dev build's steps.
 * `last` places each step on the bar (splashProgress); `start` and `done` (finish times by step id, epoch ms) time this launch.
 */
export function openSplash({ page, theme, dev, last, start = Date.now(), done = {} }) {
  const phases = SPLASH_PHASES.filter((p) => dev || !p.devOnly);
  /** Ms from `start` at which each step finished. */
  const steps = Object.fromEntries(Object.entries(done).map(([id, at]) => [id, Math.round(at - start)]));
  let completed;
  const complete = new Promise((resolve) => (completed = resolve));
  const win = new BrowserWindow({ ...SPLASH_WINDOW, show: false });
  let live = false;
  /** The furthest glide set: a later one never pulls the bar back (an overdue step glides nowhere). */
  let glided = 0;
  const render = () => {
    if (win.isDestroyed()) return Promise.resolve();
    const bar = splashProgress(phases, last, new Set(Object.keys(steps)), Date.now() - start);
    const status = (phases.find((p) => !(p.id in steps)) ?? phases[phases.length - 1]).label;
    // Shown without a glide: it starts once the bar can transition.
    if (live) glided = Math.max(glided, bar.toward);
    const state = { theme, status, live, start, ...bar, toward: live ? glided : bar.at, over: live ? bar.over : 0 };
    return win.webContents.executeJavaScript(`(${wear})(${JSON.stringify(state)})`).catch(() => undefined);
  };
  const shown = new Promise((resolve) => {
    win.webContents.once('did-finish-load', () => {
      void render().then(() => {
        if (!win.isDestroyed()) win.show();
        live = true;
        void render();
        resolve();
      });
    });
  });
  void win.loadFile(page);
  return {
    /** Settles once the splash is on screen. */
    shown,
    /** Settles with the step times once every step is done. */
    complete,
    /** Marks a step done. */
    finish(id) {
      if (id in steps) return;
      steps[id] = Math.round(Date.now() - start);
      if (phases.every((p) => p.id in steps)) completed({ ...steps });
      if (live) void render();
    },
    close() {
      if (!win.isDestroyed()) win.close();
    },
  };
}
