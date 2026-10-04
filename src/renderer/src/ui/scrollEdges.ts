// How far a scroller is from its top and bottom, whichever end it is anchored at. Read scroll position through these,
// never raw scrollTop: a column-reverse scroller (the virtual logs) counts scrollTop from 0 at the bottom, negative above.
// A virtual log's scroller answers from the log: its distances include a correction held while scrolling and its runway.
import { fromBottom, fromTop } from './scrollMath';
import { virtualScroller } from './virtualScrollers';

/** Anchored at the bottom: column-reverse. */
const bottomAnchored = (el: Element): boolean => getComputedStyle(el).flexDirection === 'column-reverse';

/** Pixels scrolled down from the top; 0 (or less, in an overscroll bounce) at the top. */
export const scrolledFromTop = (el: Element): number => virtualScroller(el)?.distanceFromTop() ?? fromTop(el, bottomAnchored(el));

/** Pixels left to scroll to the bottom; 0 (or less, in an overscroll bounce) at the bottom. */
export const scrolledFromBottom = (el: Element): number => virtualScroller(el)?.distanceFromBottom() ?? fromBottom(el, bottomAnchored(el));

/** What shows vertically of el's ancestors: the window cut down by every ancestor that clips (a virtual log's canvas, its scroller). */
export function clipBounds(el: Element): { top: number; bottom: number } {
  let top = 0;
  let bottom = window.innerHeight;
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (getComputedStyle(p).overflowY === 'visible') continue;
    const r = p.getBoundingClientRect();
    top = Math.max(top, r.top);
    bottom = Math.min(bottom, r.bottom);
  }
  return { top, bottom };
}
