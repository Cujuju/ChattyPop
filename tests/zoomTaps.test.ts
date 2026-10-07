// The Lightbox's double-tap zoom (ui/createZoom.ts): a tap moves at most 8px, and the second tap lifts within 300ms and
// 24px of the first's lift. A long first press still counts.
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Uses Solid's browser runtime so reactive state runs as in a window.
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
const { createRoot } = createRequire(import.meta.url)('solid-js/dist/solid.cjs') as typeof import('solid-js');

// Renderer modules: imported by path so the node type-check doesn't follow them.
const zoomPath = '../src/renderer/src/ui/createZoom';
const { createZoom } = (await import(zoomPath)) as { createZoom(onDismiss: () => void): { zoom(): { scale: number }; bind(img: unknown): void } };

/** The fitted image's box, and its natural width: four times larger, so a double tap zooms past 1. */
const BOX_PX = 100;
const NATURAL_PX = 400;
const TAP_MS = 80;

let zoomed: () => boolean;
let fire: (type: 'pointerdown' | 'pointermove' | 'pointerup', at: number, x?: number) => void;
beforeEach(() => {
  const listeners = new Map<string, (e: unknown) => void>();
  const img = {
    offsetWidth: BOX_PX,
    offsetHeight: BOX_PX,
    naturalWidth: NATURAL_PX,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture: () => undefined,
    addEventListener: (type: string, fn: (e: unknown) => void) => void listeners.set(type, fn),
    removeEventListener: () => undefined,
  };
  createRoot(() => {
    const z = createZoom(() => undefined);
    z.bind(img);
    zoomed = () => z.zoom().scale > 1;
  });
  fire = (type, at, x = 0) => listeners.get(type)!({ type, pointerId: 1, button: 0, clientX: x, clientY: 0, timeStamp: at });
});

/** A press at `at` lifting `holdMs` later, at `x`. */
const tap = (at: number, x = 0, holdMs = TAP_MS): void => {
  fire('pointerdown', at, x);
  fire('pointerup', at + holdMs, x);
};

describe('double-tap zoom', () => {
  it('zooms on two quick taps', () => {
    tap(0);
    tap(200);
    expect(zoomed()).toBe(true);
  });

  it('measures from lift to lift: under 300ms zooms, 300ms does not', () => {
    tap(0);
    tap(TAP_MS + 220, 0, 299 - 220);
    expect(zoomed()).toBe(true);
  });

  it('does not zoom when the second lift comes 300ms after the first', () => {
    tap(0);
    tap(TAP_MS + 220, 0, 300 - 220);
    expect(zoomed()).toBe(false);
  });

  it('treats more than 8px of movement as a drag', () => {
    tap(0);
    fire('pointerdown', 200);
    fire('pointermove', 210, 9);
    fire('pointerup', 220, 9);
    expect(zoomed()).toBe(false);
  });

  it('still counts a tap that moved 8px', () => {
    tap(0);
    fire('pointerdown', 200);
    fire('pointermove', 210, 8);
    fire('pointerup', 220, 0);
    expect(zoomed()).toBe(true);
  });

  it('counts a long first press', () => {
    tap(0, 0, 600);
    tap(650);
    expect(zoomed()).toBe(true);
  });

  it('needs the lifts under 24px apart', () => {
    tap(0);
    tap(200, 23);
    expect(zoomed()).toBe(true);
  });

  it('does not zoom when the lifts are 24px apart', () => {
    tap(0);
    tap(200, 24);
    expect(zoomed()).toBe(false);
  });
});
