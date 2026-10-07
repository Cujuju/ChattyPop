// The modal watch asks the page's isolated world to wait for each change; a new document starts closed.
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/diagnostics', () => ({ diag: () => undefined }));

const { watchModals } = await import('../src/main/discord/modalWatch');

const tick = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** A Discord page whose world answers each wait from `answers`, in order; an exhausted list leaves the wait pending. */
function fakePage(answers: (boolean | Error)[]) {
  const page = new EventEmitter();
  const scripts: string[] = [];
  const world = {
    evaluate: (code: string) => {
      scripts.push(code);
      const a = answers.shift();
      if (a === undefined) return new Promise<never>(() => undefined);
      return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
    },
  };
  return { page: page as never, world: world as never, scripts, domReady: () => page.emit('dom-ready') };
}

describe('Discord modal watch', () => {
  it('starts closed on a new document, then reports each change the world waits for', async () => {
    const p = fakePage([true, false]);
    const seen: boolean[] = [];
    watchModals(p.page, p.world, (open) => seen.push(open));
    p.domReady();
    await tick();
    expect(seen).toEqual([false, true, false]);
    expect(p.scripts[0]).toContain('[aria-modal="true"]');
    // Each wait is for a change from the state last reported, and leaves no global behind.
    expect(p.scripts[1]).toContain('!== true');
    expect(p.scripts.join('')).not.toMatch(/window\./);
  });

  it('a replaced document ends its watch; the new one starts again', async () => {
    const p = fakePage([new Error('Inspected target navigated or closed')]);
    const seen: boolean[] = [];
    watchModals(p.page, p.world, (open) => seen.push(open));
    p.domReady();
    await tick();
    p.domReady();
    await tick();
    expect(seen).toEqual([false, false]);
  });
});
