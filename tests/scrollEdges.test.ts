import { describe, expect, it } from 'vitest';
import { fromBottom, fromTop } from '../src/renderer/src/ui/scrollMath';

/** A scroller 1000px tall showing 200px. */
const box = (scrollTop: number) => ({ scrollHeight: 1000, clientHeight: 200, scrollTop });

describe('scroll edges', () => {
  it('reads a top-anchored scroller from scrollTop', () => {
    expect(fromTop(box(0), false)).toBe(0);
    expect(fromTop(box(300), false)).toBe(300);
    expect(fromBottom(box(800), false)).toBe(0);
  });

  it('reads a bottom-anchored (column-reverse) scroller, whose scrollTop is 0 at the bottom and negative above', () => {
    expect(fromBottom(box(0), true)).toBe(0);
    expect(fromTop(box(0), true)).toBe(800);
    expect(fromTop(box(-800), true)).toBe(0);
    expect(fromBottom(box(-300), true)).toBe(300);
  });

  it('puts a bottom-anchored log at its top only at the top (pull to refresh reloaded on every scroll up)', () => {
    for (const top of [0, -1, -400, -799]) expect(fromTop(box(top), true)).toBeGreaterThan(0);
  });
});
