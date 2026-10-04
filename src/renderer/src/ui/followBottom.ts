import { createSignal, onCleanup, type Accessor } from 'solid-js';
import { listen } from './listen';
import { scrolledFromBottom } from './scrollEdges';
import { virtualScroller } from './virtualScrollers';

/** Distance from the bottom that still counts as at the newest: about three compact rows, so a nudge doesn't stop following. */
const NEAR_BOTTOM_PX = 132;

export interface FollowBottom {
  /** Ref for the scroll container. Its children are watched, so rows added or growing (an image loading) keep the newest in view. */
  ref: (el: HTMLElement) => void;
  /** True while the view stays on the newest row. */
  following: Accessor<boolean>;
  /** Scrolls to the newest row and resumes following. */
  scrollToNewest: () => void;
  /** Stops following where the view is now (a jump to an older row), until the user returns to the bottom; at the bottom already, it keeps following. */
  detach: () => void;
}

/**
 * Scrolling shared by every chronological list: oldest at the top, newest at the bottom. At the bottom the list
 * follows new rows; scrolling up stops following until the user returns to the bottom. `pinned` (e.g. a window that
 * doesn't reach the newest rows, or a row held in view) also stops it.
 */
export function createFollowBottom(pinned: () => boolean = () => false): FollowBottom {
  let scroller: HTMLElement | undefined;
  const [away, setAway] = createSignal(false);
  const following = (): boolean => !away() && !pinned();
  const toEnd = (): void => {
    if (!scroller) return;
    const log = virtualScroller(scroller);
    if (log) log.scrollToBottom();
    else scroller.scrollTop += scrolledFromBottom(scroller);
  };
  const nearBottom = (el: HTMLElement): boolean => scrolledFromBottom(el) <= NEAR_BOTTOM_PX;
  return {
    following,
    scrollToNewest: () => {
      setAway(false);
      toEnd();
    },
    detach: () => void setAway(!scroller || !nearBottom(scroller)),
    ref: (el) => {
      scroller = el;
      // A virtual log (its ref first) keeps the newest row in view itself, writing only at rest; only watch for leaving.
      const log = virtualScroller(el);
      if (log) {
        // Direction from the user's own scrolling: the log's corrections and commits move its distance too.
        listen(
          el,
          'scroll',
          () => {
            if (log.distanceFromBottom() <= NEAR_BOTTOM_PX) setAway(false);
            else if (log.lastScrollDelta() > 0) setAway(true);
          },
          { passive: true },
        );
        return;
      }
      let lastTop = el.scrollTop;
      // Only scrolling up leaves the newest: rows growing after a jump (virtual rows measured, images loaded) move
      // the bottom away without the user moving, and must not stop following.
      const onScroll = (): void => {
        if (nearBottom(el)) setAway(false);
        else if (el.scrollTop < lastTop) setAway(true);
        lastTop = el.scrollTop;
      };
      // Observing the container too: a resized panel keeps the newest in view.
      const sizes = new ResizeObserver(() => {
        if (following()) toEnd();
      });
      sizes.observe(el);
      for (const child of el.children) sizes.observe(child);
      const children = new MutationObserver((records) => {
        for (const r of records) {
          r.removedNodes.forEach((n) => n instanceof Element && sizes.unobserve(n));
          r.addedNodes.forEach((n) => n instanceof Element && sizes.observe(n));
        }
      });
      children.observe(el, { childList: true });
      listen(el, 'scroll', onScroll, { passive: true });
      onCleanup(() => {
        sizes.disconnect();
        children.disconnect();
      });
    },
  };
}
