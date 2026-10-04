import type { JSX } from 'solid-js';
import { contextMenu } from '@/state/ui';
import { isTypingTarget } from './keys';
import { listen } from './listen';

/** Sideways travel that commits a swipe: past an accidental nudge, well short of the screen's width. */
export const SWIPE_COMMIT_PX = 56;
/** A still press held this long opens the menu: iOS's own long-press default (UILongPressGestureRecognizer). */
const LONG_PRESS_MS = 500;
/** A finger drifting this far is moving, not pressing: about Android's touch slop (8dp). */
const TOUCH_SLOP_PX = 10;
/** Past the commit point a swiped row drags this much heavier, as iOS rubber-bands an overscroll. */
const OVERPULL_RATIO = 0.25;

export interface TouchPoint {
  x: number;
  y: number;
}

/** A one-finger swipe from `start`: undecided (null), a vertical scroll, or committed sideways. */
export function swipeOutcome(start: TouchPoint, t: Touch): 'left' | 'right' | 'scroll' | null {
  const dx = t.clientX - start.x;
  const dy = Math.abs(t.clientY - start.y);
  if (dy >= SWIPE_COMMIT_PX) return 'scroll';
  if (Math.abs(dx) >= SWIPE_COMMIT_PX && Math.abs(dx) > dy) return dx > 0 ? 'right' : 'left';
  return null;
}

type TouchHandler = JSX.EventHandler<HTMLElement, TouchEvent>;

/**
 * Touch handlers for an element that follows a one-finger swipe to the left, as an iOS list row does, and calls `run`
 * when released past SWIPE_COMMIT_PX; while nabled() is false it stays put. Style hooks it writes: [data-swipe='drag'] while the finger is down,
 * [data-armed='true'] past the commit point, --swipe-x (travel, px) and --swipe-p (0..1 to the commit point).
 */
export function swipeLeftToAct(run: () => void, enabled: () => boolean = () => true): { onTouchStart: TouchHandler; onTouchMove: TouchHandler; onTouchEnd: TouchHandler; onTouchCancel: TouchHandler } {
  let start: TouchPoint | null = null;
  let el: HTMLElement | null = null;
  let tracking = false;
  let armed = false;
  // Back to rest; without data-swipe the stylesheet animates the return.
  const settle = (): void => {
    if (el) {
      delete el.dataset['swipe'];
      delete el.dataset['armed'];
      el.style.removeProperty('--swipe-x');
      el.style.removeProperty('--swipe-p');
    }
    start = el = null;
    tracking = armed = false;
  };
  return {
    onTouchStart: (e) => {
      settle();
      const t = e.touches[0];
      if (!t || e.touches.length > 1 || contextMenu() || !enabled()) return;
      start = { x: t.clientX, y: t.clientY };
      el = e.currentTarget;
    },
    onTouchMove: (e) => {
      const t = e.touches[0];
      if (!start || !el || !t) return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (!tracking) {
        if (Math.hypot(dx, dy) < TOUCH_SLOP_PX) return;
        // A scroll, or a rightward swipe (the drawer's), is not this gesture.
        if (dx >= 0 || Math.abs(dx) <= Math.abs(dy)) return settle();
        tracking = true;
        el.dataset['swipe'] = 'drag';
      }
      // A long press that opened the menu owns the touch now.
      if (contextMenu()) return settle();
      const travel = Math.max(0, -dx);
      const shown = travel <= SWIPE_COMMIT_PX ? travel : SWIPE_COMMIT_PX + (travel - SWIPE_COMMIT_PX) * OVERPULL_RATIO;
      armed = travel >= SWIPE_COMMIT_PX;
      el.dataset['armed'] = String(armed);
      el.style.setProperty('--swipe-x', `${-shown}px`);
      el.style.setProperty('--swipe-p', String(Math.min(1, travel / SWIPE_COMMIT_PX)));
    },
    onTouchEnd: () => {
      const act = tracking && armed;
      settle();
      if (act) run();
    },
    onTouchCancel: settle,
  };
}

/**
 * Makes a still long press fire `contextmenu` where the finger is, so every right-click menu opens by touch. iOS never
 * fires it; Android does, and its own event then stands in for this one. Call inside an owner.
 */
export function longPressOpensMenus(): void {
  let press: { x: number; y: number; timer: number; fired: boolean } | null = null;
  const cancel = (): void => {
    if (press) clearTimeout(press.timer);
    press = null;
  };

  listen(document, 'touchstart', (e) => {
    cancel();
    const t = e.touches[0];
    // A text field keeps its own long press (select, paste, caret), wherever it sits.
    if (!t || e.touches.length > 1 || isTypingTarget(e.target)) return;
    const target = e.target;
    const { clientX, clientY } = t;
    const timer = window.setTimeout(() => {
      if (!press) return;
      press.fired = true;
      target?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX, clientY }));
      if (contextMenu()) window.getSelection()?.removeAllRanges();
    }, LONG_PRESS_MS);
    press = { x: clientX, y: clientY, timer, fired: false };
  }, { passive: true });

  listen(document, 'touchmove', (e) => {
    const t = e.touches[0];
    if (press && !press.fired && t && Math.hypot(t.clientX - press.x, t.clientY - press.y) > TOUCH_SLOP_PX) cancel();
  }, { passive: true });

  // The press that opened the menu ends without a tap: its mousedown would close the menu, its click act on the row.
  listen(document, 'touchend', (e) => {
    if (press?.fired && contextMenu()) e.preventDefault();
    cancel();
  }, { passive: false });
  listen(document, 'touchcancel', cancel);

  // iOS's own long press starts selecting text under the finger as the menu opens: a press that opened a menu selects nothing.
  listen(document, 'selectstart', (e) => {
    if (press?.fired && contextMenu()) e.preventDefault();
  });

  // Android's own long-press event: the first one this press opens the menu, a second would open it again.
  listen(document, 'contextmenu', (e) => {
    if (!e.isTrusted || !press) return;
    if (press.fired) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    clearTimeout(press.timer);
    press.fired = true;
  }, true);
}
