// Scroll-edge arithmetic, DOM-free (tests import it); ui/scrollEdges.ts applies it to elements.

/** A scroller's scroll fields, as an Element has them. */
export interface ScrollBox {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}

/** Pixels scrolled down from the top. A bottom-anchored (column-reverse) scroller's scrollTop is 0 at the bottom, negative above. */
export const fromTop = (s: ScrollBox, bottomAnchored: boolean): number => (bottomAnchored ? s.scrollHeight - s.clientHeight + s.scrollTop : s.scrollTop);

/** Pixels left to scroll to the bottom. */
export const fromBottom = (s: ScrollBox, bottomAnchored: boolean): number => s.scrollHeight - s.clientHeight - fromTop(s, bottomAnchored);
