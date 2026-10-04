import { describe, expect, it } from 'vitest';
import { resizeRect } from '../src/renderer/src/ui/windowResize';

const START = { x: 100, y: 100, width: 400, height: 300 };
const MIN = { width: 360, height: 240 };
const VIEW = { width: 1000, height: 800 };

describe('floating window resize from any edge', () => {
  it('moves only the dragged edge; the opposite one stays put', () => {
    expect(resizeRect(START, 'e', 50, 999, MIN, VIEW)).toEqual({ x: 100, y: 100, width: 450, height: 300 });
    expect(resizeRect(START, 'w', -50, 0, MIN, VIEW)).toEqual({ x: 50, y: 100, width: 450, height: 300 });
    expect(resizeRect(START, 'n', 0, -40, MIN, VIEW)).toEqual({ x: 100, y: 60, width: 400, height: 340 });
    expect(resizeRect(START, 's', 0, 40, MIN, VIEW)).toEqual({ x: 100, y: 100, width: 400, height: 340 });
  });

  it('resizes both axes from a corner', () => {
    expect(resizeRect(START, 'nw', -20, -30, MIN, VIEW)).toEqual({ x: 80, y: 70, width: 420, height: 330 });
    expect(resizeRect(START, 'se', 20, 30, MIN, VIEW)).toEqual({ x: 100, y: 100, width: 420, height: 330 });
  });

  it('stops at the minimum size without moving the far edge', () => {
    expect(resizeRect(START, 'w', 200, 0, MIN, VIEW)).toEqual({ x: 140, y: 100, width: 360, height: 300 });
    expect(resizeRect(START, 'n', 0, 200, MIN, VIEW)).toEqual({ x: 100, y: 160, width: 400, height: 240 });
    expect(resizeRect(START, 'e', -200, 0, MIN, VIEW).width).toBe(360);
  });

  it('stays inside the viewport', () => {
    expect(resizeRect(START, 'w', -500, 0, MIN, VIEW)).toEqual({ x: 0, y: 100, width: 500, height: 300 });
    expect(resizeRect(START, 'se', 5000, 5000, MIN, VIEW)).toEqual({ x: 100, y: 100, width: 900, height: 700 });
  });
});
