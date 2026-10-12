// The owner's 12- or 24-hour clock: read from the OS, carried to each process, and the only way an hour is formatted.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HOUR_CYCLE_ENV, HOUR_CYCLE_GLOBAL, hourCycle, hourCycleArgs, hourCycleFromArgs, timeFormat } from '@shared/hourCycle';
import { clockViolations } from '../scripts/pluginScan/rules';

vi.mock('electron', () => ({ systemPreferences: { getUserDefault: () => false } }));
vi.mock('../src/main/diagnostics', () => ({ diag: () => undefined }));
const { hourCycleOfWindowsPattern, windowsShortTime } = await import('../src/main/osClock');

const SRC_DIR = resolve(__dirname, '../src');
const scripts = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? scripts(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));

/** 18:05 local time. */
const EVENING = new Date(2026, 9, 11, 18, 5).getTime();
const parts = (cycle: 'h12' | 'h23' | null): Record<string, string> =>
  Object.fromEntries(timeFormat({ hour: '2-digit', minute: '2-digit' }, cycle).formatToParts(EVENING).map((p) => [p.type, p.value]));

describe("the owner's clock", () => {
  it('formats an hour on the 24-hour clock or the 12-hour one, whatever the locale would pick', () => {
    expect(parts('h23')).toMatchObject({ hour: '18', minute: '05' });
    expect(parts('h23')).not.toHaveProperty('dayPeriod');
    expect(parts('h12')).toMatchObject({ hour: '06', minute: '05' });
    expect(parts('h12')).toHaveProperty('dayPeriod');
  });

  it("leaves the locale's own clock when the OS doesn't say", () => {
    const own = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(EVENING);
    expect(timeFormat({ hour: '2-digit', minute: '2-digit' }, null).format(EVENING)).toBe(own);
  });

  it('is the one a page was given by its preload, else the one in the environment', () => {
    expect(hourCycle({ [HOUR_CYCLE_GLOBAL]: 'h23' })).toBe('h23');
    expect(hourCycle({ process: { env: { [HOUR_CYCLE_ENV]: 'h12' } } })).toBe('h12');
    expect(hourCycle({ [HOUR_CYCLE_GLOBAL]: 'h23', process: { env: { [HOUR_CYCLE_ENV]: 'h12' } } })).toBe('h23');
    // Neither says, or says something else: the locale's own.
    expect(hourCycle({})).toBeNull();
    expect(hourCycle({ [HOUR_CYCLE_GLOBAL]: 'h24', process: { env: { [HOUR_CYCLE_ENV]: '24' } } })).toBeNull();
  });

  it("reaches a window's preload as an argument, and none when the OS doesn't say", () => {
    expect(hourCycleFromArgs(['electron', ...hourCycleArgs('h23'), '--other'])).toBe('h23');
    expect(hourCycleArgs(null)).toEqual([]);
    expect(hourCycleFromArgs(['electron', '--other'])).toBeNull();
  });
});

describe("Windows' time setting", () => {
  it('is 24-hour for a pattern counting to 23, 12-hour for one counting to 12', () => {
    expect(['HH:mm', 'H:mm', 'HH:mm:ss'].map(hourCycleOfWindowsPattern)).toEqual(['h23', 'h23', 'h23']);
    expect(['h:mm tt', 'hh:mm tt', 'tt h:mm'].map(hourCycleOfWindowsPattern)).toEqual(['h12', 'h12', 'h12']);
    // Quoted text is literal, and a pattern can show no hour.
    expect(["'H' h:mm tt", "HH'h'mm", 'mm:ss'].map(hourCycleOfWindowsPattern)).toEqual(['h12', 'h23', null]);
  });

  it("reads the short time pattern out of reg query's answer", () => {
    const answer = '\r\nHKEY_CURRENT_USER\\Control Panel\\International\r\n    sShortTime    REG_SZ    HH:mm\r\n\r\n';
    expect(windowsShortTime(answer)).toBe('HH:mm');
    expect(windowsShortTime(answer.replace('HH:mm', 'h:mm tt'))).toBe('h:mm tt');
    expect(windowsShortTime('ERROR: The system was unable to find the specified registry key or value.')).toBeNull();
  });
});

describe('text showing an hour', () => {
  it('is formatted with timeFormat everywhere in the app; plugin scanning warns by the same rule', () => {
    const files = scripts(SRC_DIR);
    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap((file) => clockViolations({ rel: file, text: readFileSync(file, 'utf8') }))).toEqual([]);
  });

  it("names a call that formats an hour on the locale's own clock, by line", () => {
    const text = [
      "const a = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });",
      'const b = at.toLocaleTimeString();',
      "const c = at.toLocaleString([], { dateStyle: 'long', timeStyle: 'short' });",
      "const d = at.toLocaleDateString([], { weekday: 'short' });",
      "const e = timeFormat({ hour: 'numeric' });",
      'const f = count.toLocaleString();',
    ].join('\n');
    const message = "an hour is formatted with timeFormat, which follows the owner's 12- or 24-hour clock";
    expect(clockViolations({ rel: 'x.ts', text })).toEqual([`x.ts:1: ${message}`, `x.ts:2: ${message}`, `x.ts:3: ${message}`]);
  });
});
