// Zoom and pan of an image inside its fitted box, DOM-free. Coordinates are CSS px relative to the box's top-left;
// the image is drawn as translate(x, y) scale(scale) with its transform origin at that corner.
import { pullDown } from './dragDismiss';

export interface Zoom {
  scale: number;
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Fitted: the image as the viewer lays it out. */
export const FIT: Zoom = { scale: 1, x: 0, y: 0 };

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Keeps the zoomed image covering its box, so panning stops at its edges; fitted, it doesn't move. */
function inBox(z: Zoom, box: Size): Zoom {
  return { scale: z.scale, x: clamp(z.x, box.w * (1 - z.scale), 0), y: clamp(z.y, box.h * (1 - z.scale), 0) };
}

/** Scales by `factor` (within fitted to `max`), keeping the image point under `at` where it is. */
export function zoomAt(z: Zoom, factor: number, at: Point, box: Size, max: number): Zoom {
  const scale = clamp(z.scale * factor, 1, max);
  const k = scale / z.scale;
  return inBox({ scale, x: at.x - k * (at.x - z.x), y: at.y - k * (at.y - z.y) }, box);
}

export const panBy = (z: Zoom, dx: number, dy: number, box: Size): Zoom => inBox({ scale: z.scale, x: z.x + dx, y: z.y + dy }, box);

/** How far a one-finger drag of `dy` pulls the image down to dismiss it: only when fitted (zoomed, it pans). */
export const pullOf = (z: Zoom, dy: number): number => (z.scale > 1 ? 0 : pullDown(dy));
