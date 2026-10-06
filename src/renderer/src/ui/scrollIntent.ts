import { isTypingTarget } from './keys';
import { listen } from './listen';
import { scrolledFromBottom } from './scrollEdges';

/** Keys that scroll a log, or move its row focus, toward the newest row. */
const NEWER_KEYS: ReadonlySet<string> = new Set(['ArrowDown', 'PageDown', 'End', ' ']);

/** Detects user movement toward newest via wheel/keys/touch/scrollbar inputs, including bottom-edge attempts. Programmatic scrolling does not count. */
export function onUserScrollNewer(el: HTMLElement, fn: () => void): void {
  listen(el, 'wheel', (e) => e.deltaY > 0 && fn(), { passive: true });
  listen(el, 'keydown', (e) => {
    if (NEWER_KEYS.has(e.key) && !e.shiftKey && !isTypingTarget(e.target)) fn();
  });
  let touchY: number | undefined;
  listen(el, 'touchstart', (e) => void (touchY = e.touches[0]?.clientY), { passive: true });
  listen(
    el,
    'touchmove',
    (e) => {
      const y = e.touches[0]?.clientY;
      if (y !== undefined && touchY !== undefined && y < touchY) fn();
      touchY = y;
    },
    { passive: true },
  );
  // A press right of the content box is on the scrollbar; its scrolling ends (scrollend) once the thumb is let go.
  let barFrom: number | null = null;
  listen(el, 'pointerdown', (e) => void (barFrom = e.offsetX >= el.clientWidth ? scrolledFromBottom(el) : null), { passive: true });
  listen(el, 'scroll', () => {
    if (barFrom === null) return;
    const now = scrolledFromBottom(el);
    if (now < barFrom) fn();
    barFrom = now;
  }, { passive: true });
  listen(el, 'scrollend', () => void (barFrom = null));
}
