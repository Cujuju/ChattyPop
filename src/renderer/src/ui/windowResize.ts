// Resizing a floating window from any edge or corner: pure geometry, so it can be tested without a DOM.

/** Compass edges and corners a window can be resized from. */
export const WINDOW_EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
export type WindowEdge = (typeof WINDOW_EDGES)[number];

/** A floating window's position and size in viewport px. */
export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * `start` resized by dragging `edge` by (dx, dy). The opposite edges stay put; the window keeps at least `min` and
 * stays inside `viewport` (origin 0,0).
 */
export function resizeRect(start: WindowRect, edge: WindowEdge, dx: number, dy: number, min: Size, viewport: Size): WindowRect {
  let { x, y, width, height } = start;
  if (edge.includes('e')) width = clamp(start.width + dx, min.width, viewport.width - start.x);
  if (edge.includes('w')) {
    const right = start.x + start.width;
    x = clamp(start.x + dx, 0, right - min.width);
    width = right - x;
  }
  if (edge.includes('s')) height = clamp(start.height + dy, min.height, viewport.height - start.y);
  if (edge.includes('n')) {
    const bottom = start.y + start.height;
    y = clamp(start.y + dy, 0, bottom - min.height);
    height = bottom - y;
  }
  return { x, y, width, height };
}
