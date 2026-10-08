// Places a fixed floating panel (a context menu, a select's list) inside the window.

/** Clearance kept between a floating panel and the window's edges. */
export const EDGE_MARGIN_PX = 8;

/**
 * Pulls a fixed panel at x,y inside the window, capped to it both ways (a taller one scrolls, a wider one ellipsizes).
 * Past the right edge it ends at `flip.x` when given; past the bottom it ends at `flip.y` when given. Else it slides in.
 */
export function keepOnScreen(panel: HTMLElement, x: number, y: number, flip: { x?: number; y?: number } = {}): void {
  // Native shells publish keyboard coverage without resizing the webview; browsers leave this token at zero.
  const keyboardInset = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cp-keyboard-inset')) || 0;
  const height = Math.max(0, innerHeight - keyboardInset);
  panel.style.maxHeight = `${Math.max(0, height - 2 * EDGE_MARGIN_PX)}px`;
  panel.style.maxWidth = `${Math.max(0, innerWidth - 2 * EDGE_MARGIN_PX)}px`;
  const r = panel.getBoundingClientRect();
  const left = x + r.width > innerWidth - EDGE_MARGIN_PX && flip.x !== undefined ? flip.x - r.width : x;
  const top = y + r.height > height - EDGE_MARGIN_PX && flip.y !== undefined ? flip.y - r.height : y;
  panel.style.left = `${Math.max(EDGE_MARGIN_PX, Math.min(left, innerWidth - r.width - EDGE_MARGIN_PX))}px`;
  panel.style.top = `${Math.max(EDGE_MARGIN_PX, Math.min(top, height - r.height - EDGE_MARGIN_PX))}px`;
}
