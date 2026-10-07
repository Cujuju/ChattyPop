import type { SplashPhaseId, SplashTheme } from '../shared/splash.mjs';

export declare function normalizeSplashTheme(v: unknown): SplashTheme | null;
export declare function readSplashTheme(file: string): SplashTheme | null;
export declare function writeSplashTheme(file: string, theme: unknown): void;
export interface Splash {
  shown: Promise<void>;
  finish(id: SplashPhaseId): void;
  close(): void;
}
export declare function openSplash(opts: { page: string; theme: SplashTheme | null; dev: boolean; done?: readonly SplashPhaseId[] }): Splash;
