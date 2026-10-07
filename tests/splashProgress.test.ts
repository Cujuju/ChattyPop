// The startup splash's bar: steps sit where they finished in the last launch, and the bar glides toward the next as it is expected to take.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SPLASH_GLIDE_SHARE, splashProgress, type SplashPhaseId } from '@shared/splash.mjs';
import { readSplashTimeline, writeSplashTimeline } from '../src/main/splashWindow.mjs';

vi.mock('electron', () => ({ BrowserWindow: class {} }));

const phases: { id: SplashPhaseId }[] = [{ id: 'build' }, { id: 'archive' }, { id: 'interface' }, { id: 'window' }];
const last = { build: 6000, archive: 9000, interface: 8000, window: 10000 };
const done = (...ids: SplashPhaseId[]): Set<SplashPhaseId> => new Set(ids);
const file = (): string => join(mkdtempSync(join(tmpdir(), 'splash-timeline-')), 'splash-timeline.json');

describe('the splash bar', () => {
  it('spaces steps evenly, with no glide, without a full last launch', () => {
    expect(splashProgress(phases, undefined, done('build'), 0)).toEqual({ at: 0.25, toward: 0.25, over: 0 });
    expect(splashProgress(phases, { build: 6000 }, done('build', 'archive'), 0)).toEqual({ at: 0.5, toward: 0.5, over: 0 });
  });

  it('places each finished step where it finished last time', () => {
    expect(splashProgress(phases, last, done('build'), 6000).at).toBe(0.6);
    expect(splashProgress(phases, last, done('build', 'archive', 'interface', 'window'), 10000).at).toBe(1);
  });

  it('follows the furthest finished step when steps finish out of order', () => {
    expect(splashProgress(phases, last, done('build', 'interface'), 8000).at).toBe(0.8);
    expect(splashProgress(phases, last, done('build', 'archive'), 9000).at).toBe(0.9);
  });

  it('glides short of the next step, over the time it is expected to take', () => {
    expect(splashProgress(phases, last, done(), 1000)).toEqual({ at: 0, toward: SPLASH_GLIDE_SHARE * 0.6, over: 5000 });
    const bar = splashProgress(phases, last, done('build'), 6500);
    expect(bar.over).toBe(1500);
    expect(bar.toward).toBeCloseTo(0.6 + SPLASH_GLIDE_SHARE * 0.2);
  });

  it('skips a step already finished out of order', () => {
    expect(splashProgress(phases, last, done('build', 'archive'), 9000)).toEqual({ at: 0.9, toward: 0.9 + SPLASH_GLIDE_SHARE * 0.1, over: 1000 });
  });

  it('stops gliding once the next step is overdue', () => {
    expect(splashProgress(phases, last, done('build'), 8000)).toEqual({ at: 0.6, toward: 0.6, over: 0 });
  });
});

describe('the splash timeline', () => {
  it('reads nothing from a missing or unreadable file', () => {
    const f = file();
    expect(readSplashTimeline(f, true)).toBeNull();
    writeFileSync(f, '{not json');
    expect(readSplashTimeline(f, true)).toBeNull();
  });

  it('keeps each mode apart', () => {
    const f = file();
    writeSplashTimeline(f, true, { steps: last });
    writeSplashTimeline(f, false, { steps: { archive: 900 } });
    expect(readSplashTimeline(f, true)).toEqual({ steps: last });
    expect(readSplashTimeline(f, false)).toEqual({ steps: { archive: 900 } });
  });

  it('drops unknown steps and bad times', () => {
    const f = file();
    writeSplashTimeline(f, true, { steps: { build: 6000, archive: -1, interface: 'soon', other: 5 } });
    expect(readSplashTimeline(f, true)).toEqual({ steps: { build: 6000 } });
  });

  it('leaves the file alone for a timeline with no steps', () => {
    const f = file();
    writeSplashTimeline(f, true, { steps: last });
    writeSplashTimeline(f, true, { steps: {} });
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ dev: { steps: last } });
  });
});
