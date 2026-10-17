import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');

/** A child process starts V8 in the requested zone, including on Windows. */
function bounds(zone: string, date: string, missingTime: string): { since: number; until: number; rejected: boolean[] } {
  const script = `
    import { runnerImport } from 'vite';
    const { module: { parseToolTime } } = await runnerImport(${JSON.stringify(resolve(ROOT, 'src/core/ai/archiveToolKit.ts'))}, {
      configFile: false, logLevel: 'silent', resolve: { alias: { '@shared': ${JSON.stringify(resolve(ROOT, 'src/shared'))} } },
    });
    const date = ${JSON.stringify(date)};
    const missingTime = ${JSON.stringify(missingTime)};
    const rejected = ['since', 'until'].map((bound) => {
      try { parseToolTime(missingTime, bound); return false; } catch { return true; }
    });
    console.log(JSON.stringify({ since: parseToolTime(date, 'since'), until: parseToolTime(date, 'until'), rejected }));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT, env: { ...process.env, TZ: zone }, encoding: 'utf8',
  }));
}

describe('archive tool local day bounds in explicit time zones', () => {
  it.each([
    ['America/Santiago', '2026-09-06', '2026-09-06 00:30', '2026-09-06T04:00:00.000Z', '2026-09-07T02:59:59.999Z'],
    ['America/Santiago', '2026-09-05', '2026-09-06 00:00', '2026-09-05T04:00:00.000Z', '2026-09-06T03:59:59.999Z'],
    ['America/Los_Angeles', '2026-03-08', '2026-03-08 02:30', '2026-03-08T08:00:00.000Z', '2026-03-09T06:59:59.999Z'],
    ['America/Los_Angeles', '2026-11-01', '2026-03-08 02:30', '2026-11-01T07:00:00.000Z', '2026-11-02T07:59:59.999Z'],
  ])('covers the existing instants of %s %s and rejects explicit skipped times', (zone, date, missingTime, since, until) => {
    expect(bounds(zone, date, missingTime)).toEqual({ since: Date.parse(since), until: Date.parse(until), rejected: [true, true] });
  });
});
