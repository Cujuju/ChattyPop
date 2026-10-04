import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// The browser build: node resolves solid-js to its server build, where effects never run.
const solid = createRequire(import.meta.url)('solid-js/dist/solid.cjs') as typeof import('solid-js');
vi.mock('solid-js', () => solid);
vi.mock('@plugin-sdk/renderer/settings', async () => {
  const { createSignal } = solid;
  return { createSetting: <T>(_key: string, initial: T) => createSignal(initial) };
});

interface Area { x: number; y: number; width: number; height: number }
/** The slot side of the check: the fields of the DOMRect it reads. */
interface SlotRect { left: number; top: number; right: number; bottom: number }

// A path variable: the node typecheck has no renderer aliases or DOM types (as tests/forwardAttempts.test.ts).
const statePath = '../src/renderer/src/state/windows';
const { setOverlayCover, windowsCover } = (await import(statePath)) as {
  setOverlayCover(id: string, area: Area | 'window' | null): void;
  windowsCover(r: SlotRect): boolean;
};

/** The live Discord view's slot, as a DOMRect would report it. */
const slot: SlotRect = { left: 300, top: 50, right: 900, bottom: 650 };

describe('overlay covers hide the live Discord view', () => {
  it('a whole-window overlay covers any slot until it closes', () => {
    expect(windowsCover(slot)).toBe(false);
    setOverlayCover('lightbox', 'window');
    expect(windowsCover(slot)).toBe(true);
    setOverlayCover('lightbox', null);
    expect(windowsCover(slot)).toBe(false);
  });

  it('a menu covers the slot only where its area overlaps it', () => {
    setOverlayCover('menu', { x: 10, y: 10, width: 200, height: 300 });
    expect(windowsCover(slot)).toBe(false);
    setOverlayCover('menu', { x: 250, y: 10, width: 200, height: 300 });
    expect(windowsCover(slot)).toBe(true);
    setOverlayCover('menu', null);
    expect(windowsCover(slot)).toBe(false);
  });

  it('overlays are tracked separately: closing one keeps another', () => {
    setOverlayCover('lightbox', 'window');
    setOverlayCover('menu', { x: 250, y: 10, width: 200, height: 300 });
    setOverlayCover('menu', null);
    expect(windowsCover(slot)).toBe(true);
    setOverlayCover('lightbox', null);
  });

  it('an effect that reports a cover runs once per change, not on its own write', async () => {
    const [open, setOpen] = solid.createSignal(false);
    let runs = 0;
    const dispose = solid.createRoot((done) => {
      solid.createEffect(() => {
        runs++;
        setOverlayCover('viewer', open() ? 'window' : null);
      });
      return done;
    });
    await Promise.resolve();
    setOpen(true);
    setOpen(false);
    expect(runs).toBe(3);
    expect(windowsCover(slot)).toBe(false);
    dispose();
  });
});