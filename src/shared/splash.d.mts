export declare const SPLASH_WINDOW: {
  width: number;
  height: number;
  frame: boolean;
  resizable: boolean;
  maximizable: boolean;
  minimizable: boolean;
  fullscreenable: boolean;
  center: boolean;
  title: string;
};
export declare const SPLASH_SHOWN_MESSAGE: string;
export type SplashPhaseId = 'build' | 'archive' | 'interface' | 'window';
export declare const SPLASH_PHASES: readonly { id: SplashPhaseId; label: string; devOnly?: boolean }[];
export declare const SPLASH_THEME_TOKENS: readonly string[];
export declare const SPLASH_THEME_FILE: string;
/** Resolved values of SPLASH_THEME_TOKENS, by token. */
export type SplashTheme = Record<string, string>;
