// The 12- or 24-hour clock the owner set in the OS, which Chromium's Intl doesn't follow (src/shared/hourCycle.ts).
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { systemPreferences } from 'electron';
import { errorMessage } from '@shared/errors';
import { HOUR_CYCLE_ENV, type HourCycle } from '@shared/hourCycle';
import { MS_PER_S } from '@shared/units';
import { diag } from './diagnostics';
import { IS_MAC, IS_WINDOWS } from './platform';

/** Where Windows keeps the owner's regional formats, and its short time pattern ("HH:mm", "h:mm tt"). */
const WINDOWS_FORMATS_KEY = 'HKCU\\Control Panel\\International';
const WINDOWS_SHORT_TIME = 'sShortTime';
/** Used when the environment names no Windows folder. */
const DEFAULT_SYSTEM_ROOT = 'C:\\Windows';
/** reg.exe answers in milliseconds; a stuck one must not hold the start. */
const REG_TIMEOUT_MS = 2 * MS_PER_S;
/** macOS's overrides of the region's clock (System Settings → Date & Time → 24-hour time). */
const MAC_FORCE_24 = 'AppleICUForce24HourTime';
const MAC_FORCE_12 = 'AppleICUForce12HourTime';

/** The clock a Windows time pattern shows: `H` counts to 23, `h` to 12; text in quotes is literal. Null when it has no hour. */
export function hourCycleOfWindowsPattern(pattern: string): HourCycle | null {
  const fields = pattern.replace(/'[^']*'/g, '');
  if (fields.includes('H')) return 'h23';
  return fields.includes('h') ? 'h12' : null;
}

/** The short time pattern in `reg query`'s output; null when the value isn't there. */
export const windowsShortTime = (output: string): string | null =>
  new RegExp(`^\\s*${WINDOWS_SHORT_TIME}\\s+REG_SZ\\s+(.+?)\\s*$`, 'm').exec(output)?.[1] ?? null;

function windowsHourCycle(): HourCycle | null {
  // By its full path: the PATH is the owner's.
  const reg = join(process.env['SystemRoot'] ?? DEFAULT_SYSTEM_ROOT, 'System32', 'reg.exe');
  const output = execFileSync(reg, ['query', WINDOWS_FORMATS_KEY, '/v', WINDOWS_SHORT_TIME], { encoding: 'utf8', timeout: REG_TIMEOUT_MS, windowsHide: true });
  const pattern = windowsShortTime(output);
  return pattern === null ? null : hourCycleOfWindowsPattern(pattern);
}

function macHourCycle(): HourCycle | null {
  if (systemPreferences.getUserDefault(MAC_FORCE_24, 'boolean')) return 'h23';
  return systemPreferences.getUserDefault(MAC_FORCE_12, 'boolean') ? 'h12' : null;
}

/** The OS's clock; null when it doesn't say (the region's default stands) or can't be asked. */
function osHourCycle(): HourCycle | null {
  try {
    if (IS_WINDOWS) return windowsHourCycle();
    return IS_MAC ? macHourCycle() : null;
  } catch (err) {
    diag('os-clock-failed', { message: errorMessage(err) });
    return null;
  }
}

/** Before core and any window start: both take the clock from this process (core its environment, a window its preload). */
export function applyOsHourCycle(): void {
  const cycle = osHourCycle();
  if (cycle) process.env[HOUR_CYCLE_ENV] = cycle;
  // A relaunch inherits the last start's.
  else delete process.env[HOUR_CYCLE_ENV];
}
