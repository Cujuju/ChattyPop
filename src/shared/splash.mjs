// The startup splash's contract. Plain JS: the dev launcher (scripts/dev.mjs) runs it before anything builds.

/** The splash window: small, frameless, centred. */
export const SPLASH_WINDOW = {
  width: 360,
  height: 240,
  frame: false,
  resizable: false,
  maximizable: false,
  minimizable: false,
  fullscreenable: false,
  center: true,
  title: 'ChattyPop',
};

/** What the app sends a launcher that spawned it (scripts/dev.mjs) once the app's own splash shows. */
export const SPLASH_SHOWN_MESSAGE = 'splash-shown';

/** Startup steps in order. The bar fills by those done; the status names the first not done. `devOnly` runs before the app exists. */
export const SPLASH_PHASES = [
  { id: 'build', label: 'Building the app', devOnly: true },
  { id: 'archive', label: 'Opening the archive' },
  { id: 'interface', label: 'Loading the interface' },
  { id: 'window', label: 'Opening the window' },
];

/** The theme tokens the splash wears (theme/splash.css). The main window saves their resolved values; the next splash wears them. */
export const SPLASH_THEME_TOKENS = ['--cp-color-scheme', '--cp-border', '--cp-surface-1', '--cp-surface-5', '--cp-text-1', '--cp-text-muted', '--cp-accent'];

/** Profile file holding the resolved splash tokens. */
export const SPLASH_THEME_FILE = 'splash-theme.json';
