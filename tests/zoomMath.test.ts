// Contract: zoom keeps the pinched/wheeled point still, stays within fitted..max, and pans only within the image's edges.
import { describe, expect, it } from 'vitest';
import { FIT, panBy, zoomAt } from '../src/renderer/src/ui/zoomMath';

const BOX = { w: 400, h: 300 };
const MAX = 6;

describe('image zoom', () => {
  it('keeps the point under the fingers where it is', () => {
    const at = { x: 100, y: 200 };
    const z = zoomAt(FIT, 2, at, BOX, MAX);
    expect(z.scale).toBe(2);
    // The image point under `at` before (at itself, fitted) is still under it: x + scale * u = at.
    expect(z.x + z.scale * at.x).toBe(at.x);
    expect(z.y + z.scale * at.y).toBe(at.y);
  });

  it('never goes below fitted or above the maximum', () => {
    expect(zoomAt(FIT, 0.5, { x: 10, y: 10 }, BOX, MAX)).toEqual(FIT);
    expect(zoomAt(FIT, 100, { x: 10, y: 10 }, BOX, MAX).scale).toBe(MAX);
  });

  it('pans only as far as the zoomed image’s edges; fitted, it does not move', () => {
    expect(panBy(FIT, 50, 50, BOX)).toEqual(FIT);
    const z = zoomAt(FIT, 2, { x: 0, y: 0 }, BOX, MAX);
    expect(panBy(z, 1000, 1000, BOX)).toEqual({ scale: 2, x: 0, y: 0 });
    expect(panBy(z, -1000, -1000, BOX)).toEqual({ scale: 2, x: -400, y: -300 });
  });

  it('zooming back out to fitted recentres the image', () => {
    const z = panBy(zoomAt(FIT, 3, { x: 300, y: 100 }, BOX, MAX), -80, 40, BOX);
    expect(zoomAt(z, 1 / 3, { x: 50, y: 50 }, BOX, MAX)).toEqual(FIT);
  });
});
