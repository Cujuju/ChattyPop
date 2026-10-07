export declare const SPLASH_WINDOW: {
  width: number;
  height: number;
  frame: boolean;
  transparent: boolean;
  resizable: boolean;
  maximizable: boolean;
  minimizable: boolean;
  fullscreenable: boolean;
  center: boolean;
  title: string;
};
export declare const SPLASH_SHOWN_MESSAGE: string;
export type SplashPhaseId = 'compile' | 'build' | 'app' | 'core' | 'database' | 'archive' | 'interface' | 'window';
export declare const SPLASH_PHASES: readonly { id: SplashPhaseId; label: string; devOnly?: boolean }[];
export declare const SPLASH_THEME_TOKENS: readonly string[];
export declare const SPLASH_THEME_FILE: string;
/** Resolved values of SPLASH_THEME_TOKENS, by token. */
export type SplashTheme = Record<string, string>;
export declare const SPLASH_TIMELINE_FILE: string;
export declare const DEV_LAUNCH_ENV: string;
/** Ms from launch start at which each step finished, by step id. */
export type SplashSteps = Partial<Record<SplashPhaseId, number>>;
/** One mode's last launch. */
export interface SplashTimeline {
  steps: SplashSteps;
}
export declare const SPLASH_GLIDE_SHARE: number;
export interface SplashBar {
  at: number;
  toward: number;
  over: number;
}
export declare function splashProgress(
  phases: readonly { id: SplashPhaseId }[],
  last: SplashSteps | undefined,
  finished: ReadonlySet<SplashPhaseId>,
  elapsed: number,
): SplashBar;
