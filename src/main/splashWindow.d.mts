import type { SplashPhaseId, SplashSteps, SplashTheme, SplashTimeline } from '../shared/splash.mjs';

export declare function normalizeSplashTheme(v: unknown): SplashTheme | null;
export declare function readSplashTheme(file: string): SplashTheme | null;
export declare function writeSplashTheme(file: string, theme: unknown): void;
export declare function readSplashTimeline(file: string, dev: boolean): SplashTimeline | null;
export declare function writeSplashTimeline(file: string, dev: boolean, timeline: unknown): void;
export interface Splash {
  shown: Promise<void>;
  /** Settles with the step times once every step is done. */
  complete: Promise<SplashSteps>;
  finish(id: SplashPhaseId): void;
  close(): void;
}
export declare function openSplash(opts: {
  page: string;
  theme: SplashTheme | null;
  dev: boolean;
  /** The last launch's step times: where each step sits on the bar. */
  last?: SplashSteps;
  /** Launch start, epoch ms. */
  start?: number;
  /** Steps done before the splash opened: epoch ms by step id. */
  done?: SplashSteps;
}): Splash;
