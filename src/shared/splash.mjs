// The startup splash's contract. Plain JS: the dev launcher (scripts/dev.mjs) runs it before anything builds.

/** The splash window: small, frameless, centred. Transparent, so its page can round the corners (theme/splash.css). */
export const SPLASH_WINDOW = {
  width: 360,
  height: 240,
  frame: false,
  transparent: true,
  resizable: false,
  maximizable: false,
  minimizable: false,
  fullscreenable: false,
  center: true,
  title: 'ChattyPop',
};

/** What the app sends a launcher that spawned it (scripts/dev.mjs) once the app's own splash shows. */
export const SPLASH_SHOWN_MESSAGE = 'splash-shown';

/** Startup steps in order. The status names the first not done. `devOnly` runs before the app exists. */
export const SPLASH_PHASES = [
  { id: 'compile', label: 'Compiling the app', devOnly: true },
  { id: 'build', label: 'Bundling the app', devOnly: true },
  { id: 'archive', label: 'Opening the archive' },
  { id: 'interface', label: 'Loading the interface' },
  { id: 'window', label: 'Opening the window' },
];

/** The theme tokens the splash wears (theme/splash.css). The main window saves their resolved values; the next splash wears them. */
export const SPLASH_THEME_TOKENS = ['--cp-color-scheme', '--cp-border', '--cp-surface-1', '--cp-surface-5', '--cp-text-1', '--cp-text-muted', '--cp-accent'];

/** Profile file holding the resolved splash tokens. */
export const SPLASH_THEME_FILE = 'splash-theme.json';

/** Profile file holding the last launch's timeline, by mode (dev, release): when each step finished. */
export const SPLASH_TIMELINE_FILE = 'splash-timeline.json';

/** Environment variable through which the dev launcher (scripts/dev.mjs) tells its splash and the app the launch so far: JSON `{ start, done }`, epoch ms. */
export const DEV_LAUNCH_ENV = 'CHATTYPOP_DEV_LAUNCH';

/** Share of the way to the next step's end the bar glides while that step runs: only the step finishing fills the rest. */
export const SPLASH_GLIDE_SHARE = 0.9;

/**
 * The bar. `at` (0..1): the furthest finished step's end, each step ending where it finished in the last launch
 * (`last`: ms from launch start, by step id), or evenly spaced without a full timeline. `toward`: where the bar may glide,
 * over `over` ms, as the next step is expected to take. No glide without a timeline, or once the next step is overdue.
 */
export function splashProgress(phases, last, finished, elapsed) {
  const timed = phases.every((p) => last?.[p.id] > 0);
  const total = timed ? Math.max(...phases.map((p) => last[p.id])) : phases.length;
  const ends = phases.map((p, i) => ({ id: p.id, end: (timed ? last[p.id] : i + 1) / total })).sort((a, b) => a.end - b.end);
  const at = Math.max(0, ...ends.filter((e) => finished.has(e.id)).map((e) => e.end));
  const next = ends.find((e) => !finished.has(e.id) && e.end > at);
  const over = timed && next ? Math.round(last[next.id] - elapsed) : 0;
  return over > 0 ? { at, toward: at + SPLASH_GLIDE_SHARE * (next.end - at), over } : { at, toward: at, over: 0 };
}
