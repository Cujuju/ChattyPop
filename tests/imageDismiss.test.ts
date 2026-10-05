// Contract: dragging the fitted image down pulls it (never up), and letting go far enough down dismisses the viewer;
// a zoomed image pans instead, and a cancelled gesture never dismisses.
import { describe, expect, it } from 'vitest';
import { DISMISS_DRAG_PX, FIT, dismisses, pullOf } from '../src/renderer/src/ui/zoomMath';

const ZOOMED = { scale: 2, x: -100, y: -100 };

describe('drag the image down to dismiss', () => {
  it('follows the finger down, never up', () => {
    expect(pullOf(FIT, 60)).toBe(60);
    expect(pullOf(FIT, -60)).toBe(0);
  });

  it('a zoomed image pans instead', () => {
    expect(pullOf(ZOOMED, DISMISS_DRAG_PX * 2)).toBe(0);
  });

  it('dismisses only when let go far enough down', () => {
    expect(dismisses(DISMISS_DRAG_PX - 1, true)).toBe(false);
    expect(dismisses(DISMISS_DRAG_PX, true)).toBe(true);
  });

  it('a cancelled gesture never dismisses', () => {
    expect(dismisses(DISMISS_DRAG_PX * 2, false)).toBe(false);
  });
});
