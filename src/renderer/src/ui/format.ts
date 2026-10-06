import type { PlanUsageWindow } from '@shared/contract';
import { BYTES_PER_GB, BYTES_PER_MB, MS_PER_MIN } from '@shared/units';

const THOUSAND = 1000;
const MILLION = 1_000_000;

/** Disk size: whole MB below a GB, else GB to one decimal. */
export const formatBytes = (bytes: number): string =>
  bytes >= BYTES_PER_GB ? `${(bytes / BYTES_PER_GB).toFixed(1)} GB` : `${(bytes / BYTES_PER_MB).toFixed(0)} MB`;

/** Compact token count: 950, 12.3k, 1.4M. */
export function formatTokens(n: number): string {
  if (n >= MILLION) return `${(n / MILLION).toFixed(1)}M`;
  if (n >= THOUSAND) return `${(n / THOUSAND).toFixed(1)}k`;
  return String(n);
}

/** "1 hit", "3 hits": a count with its word, plural unless one. */
export const countText = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`;

/** A core error for display, without Electron's IPC wrapper text. */
export const errorText = (err: unknown): string =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err);

const PERCENT = 100;
/** "42%" for a 0..1 fraction. */
export const percentText = (fraction: number): string => `${Math.round(fraction * PERCENT)}%`;

/** A plan window's use, "42%"; "?" when the provider reports none. */
export const planPercentText = (w: PlanUsageWindow): string => (w.usedPercent === null ? '?' : `${Math.round(w.usedPercent)}%`);

const SCORE_DIGITS = 1;

/** A Jev answer for display: "level 2.4" for a score, else a percentage led by the chosen option. */
export const jevValueText = (kind: 'noul' | 'choice' | 'score', value: number, choice: string | null): string =>
  kind === 'score' ? `level ${value.toFixed(SCORE_DIGITS)}` : `${choice ? `${choice} · ` : ''}${percentText(value)}`;

const CENT = 0.01;
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
/** Uses two significant digits to show sub-cent Jev costs. */
const USD_FRACTION = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumSignificantDigits: 2 });

/** Dollars: cents from a cent up ($0.41), two significant digits below ($0.000015). */
export const usdText = (usd: number): string => (usd === 0 || usd >= CENT ? USD : USD_FRACTION).format(usd);

export { clockTime, messageTime, shortDate, shortDateTime, weekdayDate, weekdayDateTime, yearDate } from './dates';

/** yyyy-mm-ddThh:mm, the length a datetime-local input takes. */
const LOCAL_INPUT_LENGTH = 16;

/** ms → the local-time string a datetime-local input shows. */
export const toLocalInput = (ms: number): string => new Date(ms - new Date(ms).getTimezoneOffset() * MS_PER_MIN).toISOString().slice(0, LOCAL_INPUT_LENGTH);

/** Two datetime-local values as a time range; null unless both parse and `from` is before `to`. */
export function localRange(from: string, to: string): { fromTs: number; toTs: number } | null {
  const fromTs = new Date(from).getTime();
  const toTs = new Date(to).getTime();
  return Number.isFinite(fromTs) && Number.isFinite(toTs) && fromTs < toTs ? { fromTs, toTs } : null;
}

/** A length token (--cp-*) in px, for layout code that needs a number (e.g. virtual list padding). */
export const tokenPx = (name: string): number => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;
