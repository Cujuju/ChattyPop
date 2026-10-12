// The owner's clock: 12- or 24-hour. Chromium's Intl takes it from the UI language, not from the OS's time setting, so
// main reads the OS's (src/main/osClock.ts) and every text that shows an hour is formatted through timeFormat.

/** h23: "18:05". h12: "6:05 PM". */
export type HourCycle = 'h12' | 'h23';

/** Set by main at boot; core inherits it. */
export const HOUR_CYCLE_ENV = 'CHATTYPOP_HOUR_CYCLE';
/** The argument main passes a window's preload, which sets HOUR_CYCLE_GLOBAL on the page. */
export const HOUR_CYCLE_ARG = '--cp-hour-cycle=';
export const HOUR_CYCLE_GLOBAL = 'chattypopHourCycle';

const known = (value: unknown): HourCycle | null => (value === 'h12' || value === 'h23' ? value : null);

/**
 * This process's clock: a page's from its preload, main's and core's from the environment. Null leaves the locale's
 * own: a browser, a test, or an OS that doesn't say.
 */
export function hourCycle(scope: object = globalThis): HourCycle | null {
  const g = scope as { [HOUR_CYCLE_GLOBAL]?: unknown; process?: { env?: Record<string, string | undefined> } };
  return known(g[HOUR_CYCLE_GLOBAL]) ?? known(g.process?.env?.[HOUR_CYCLE_ENV]);
}

/** A formatter of local date and time text, in the owner's locale and clock. */
export const timeFormat = (options: Intl.DateTimeFormatOptions, cycle: HourCycle | null = hourCycle()): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat(undefined, { ...options, ...(cycle && { hourCycle: cycle }) });

/** What a window's preload is passed for `cycle`; nothing when the OS doesn't say. */
export const hourCycleArgs = (cycle: HourCycle | null = hourCycle()): string[] => (cycle ? [`${HOUR_CYCLE_ARG}${cycle}`] : []);

/** The clock among a preload's arguments. */
export const hourCycleFromArgs = (argv: readonly string[]): HourCycle | null =>
  known(argv.find((a) => a.startsWith(HOUR_CYCLE_ARG))?.slice(HOUR_CYCLE_ARG.length));
