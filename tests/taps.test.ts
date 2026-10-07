// Tap recognition (ui/taps.ts): a tap is short and still; two taps close in time and place make one double tap.
import { describe, expect, it } from 'vitest';
import { DOUBLE_TAP_MS, DOUBLE_TAP_SLOP_PX, LONG_PRESS_MS, TOUCH_SLOP_PX, createDoubleTap, type DoubleTap } from '../src/renderer/src/ui/taps';

/** A quick still tap's press-to-lift time. */
const TAP_MS = 80;
/** A gap between taps well inside the double-tap window. */
const GAP_MS = 120;

/** Taps at (x, y) pressing at `at`; returns whether the lift completed a double tap. */
const tap = (r: DoubleTap, at: number, x = 0, y = 0, holdMs = TAP_MS): boolean => {
  r.down({ at, x, y });
  return r.up({ at: at + holdMs, x, y });
};

describe('a double tap', () => {
  it('is two quick still taps in one place', () => {
    const r = createDoubleTap();
    expect(tap(r, 0)).toBe(false);
    expect(tap(r, TAP_MS + GAP_MS)).toBe(true);
  });

  it('counts the window from the first lift to the second press', () => {
    const r = createDoubleTap();
    tap(r, 0);
    expect(tap(r, TAP_MS + DOUBLE_TAP_MS)).toBe(true);
    const late = createDoubleTap();
    tap(late, 0);
    expect(tap(late, TAP_MS + DOUBLE_TAP_MS + 1)).toBe(false);
  });

  it('starts over from a late second tap, which becomes the first', () => {
    const r = createDoubleTap();
    tap(r, 0);
    const second = TAP_MS + DOUBLE_TAP_MS + 1;
    expect(tap(r, second)).toBe(false);
    expect(tap(r, second + TAP_MS + GAP_MS)).toBe(true);
  });

  it('needs the second press near the first', () => {
    const r = createDoubleTap();
    tap(r, 0);
    expect(tap(r, TAP_MS + GAP_MS, DOUBLE_TAP_SLOP_PX + 1)).toBe(false);
    const near = createDoubleTap();
    tap(near, 0);
    expect(tap(near, TAP_MS + GAP_MS, DOUBLE_TAP_SLOP_PX)).toBe(true);
  });

  it('fires once for three taps: the third starts a new pair', () => {
    const r = createDoubleTap();
    const step = TAP_MS + GAP_MS;
    expect([tap(r, 0), tap(r, step), tap(r, 2 * step), tap(r, 3 * step)]).toEqual([false, true, false, true]);
  });
});

describe('not a tap', () => {
  it('a long press (the menu)', () => {
    const r = createDoubleTap();
    tap(r, 0);
    expect(tap(r, TAP_MS + GAP_MS, 0, 0, LONG_PRESS_MS)).toBe(false);
  });

  it('a press that drifts past the slop (a swipe or scroll), which also breaks the pair', () => {
    const r = createDoubleTap();
    tap(r, 0);
    const at = TAP_MS + GAP_MS;
    r.down({ at, x: 0, y: 0 });
    r.move({ at: at + 1, x: -(TOUCH_SLOP_PX + 1), y: 0 });
    expect(r.up({ at: at + TAP_MS, x: 0, y: 0 })).toBe(false);
    // The swipe broke the pair: the next tap is a first again.
    expect(tap(r, at + TAP_MS + GAP_MS)).toBe(false);
  });

  it('a lift far from its press, even without moves', () => {
    const r = createDoubleTap();
    tap(r, 0);
    const at = TAP_MS + GAP_MS;
    r.down({ at, x: 0, y: 0 });
    expect(r.up({ at: at + TAP_MS, x: TOUCH_SLOP_PX + 1, y: 0 })).toBe(false);
  });

  it('a cancelled press (a second finger), which forgets the first tap', () => {
    const r = createDoubleTap();
    tap(r, 0);
    r.down({ at: TAP_MS + GAP_MS, x: 0, y: 0 });
    r.cancel();
    expect(r.up({ at: TAP_MS + GAP_MS + TAP_MS, x: 0, y: 0 })).toBe(false);
    expect(tap(r, 2 * (TAP_MS + GAP_MS))).toBe(false);
  });
});
