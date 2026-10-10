// A phone sheet's pulls, as iOS sheets have them: down to close, and for a sheet with two heights, up to expand.
import { listen } from './listen';
import { scrolledFromTop } from './scrollEdges';

/** A sheet pulled past this share of the distance closes (or changes height) on release, as iOS sheets do; short of it, it springs back. */
const SHEET_DISMISS_RATIO = 0.25;
/**
 * Travel before a touch counts as a pull, iOS's pan threshold (10 pt). Under it the touch stays a tap: a finger's wobble
 * must not start a pull, whose prevented touchmove would cancel the tap's click.
 */
const PULL_SLOP_PX = 10;

/** A sheet with two heights: its CSS sets each from `expanded` (a data attribute); a pull moves between them. */
export interface SheetExpand {
  expanded: () => boolean;
  setExpanded: (on: boolean) => void;
}

/**
 * Pulls on a phone sheet. Down, from the top of `scroller` (what scrolls inside it, the sheet by default): the sheet
 * follows, and past SHEET_DISMISS_RATIO of its height it closes on release, or, expanded, returns to its first height.
 * Up, with `expand` and not yet expanded, from anywhere: the sheet grows with the finger to its max-height, and past
 * SHEET_DISMISS_RATIO of that rise it stays expanded. data-pull disables the snap transitions while dragging.
 * `grip`: the part of the sheet that takes the pulls (all of it by default), leaving the rest to scroll; it is
 * its own `scroller`, as it never scrolls.
 */
export function pullToClose(sheet: HTMLElement, close: () => void, scroller: HTMLElement = sheet, expand?: SheetExpand, grip: HTMLElement = sheet): void {
  let startY: number | null = null;
  let atTop = false;
  let canRise = false;
  let startHeight = 0;
  let maxHeight = 0;
  /** Decided by the first move: 'down' pulls the sheet down, 'up' raises it, 'scroll' leaves the touch to the content. */
  let mode: 'down' | 'up' | 'scroll' | null = null;
  let moved = 0;
  const settle = (): void => {
    startY = null;
    mode = null;
    moved = 0;
    delete sheet.dataset['pull'];
    sheet.style.removeProperty('translate');
    sheet.style.removeProperty('height');
  };
  listen(
    grip,
    'touchstart',
    (e) => {
      const t = e.touches[0];
      if (!t || e.touches.length !== 1) return settle();
      atTop = scrolledFromTop(scroller) <= 0;
      canRise = expand !== undefined && !expand.expanded();
      startY = atTop || canRise ? t.clientY : null;
      startHeight = sheet.offsetHeight;
      maxHeight = parseFloat(getComputedStyle(sheet).maxHeight) || startHeight;
    },
    { passive: true },
  );
  // Not passive: a pull replaces the content's own scrolling.
  listen(
    grip,
    'touchmove',
    (e) => {
      const t = e.touches[0];
      if (startY === null || !t || mode === 'scroll') return;
      const dy = t.clientY - startY;
      if (mode === null && Math.abs(dy) < PULL_SLOP_PX) return;
      mode ??= dy > 0 && atTop ? 'down' : dy < 0 && canRise ? 'up' : 'scroll';
      if (mode === 'down') {
        moved = Math.max(0, dy);
        sheet.style.translate = `0 ${moved}px`;
      } else if (mode === 'up') {
        moved = Math.max(0, -dy);
        sheet.style.height = `${Math.min(maxHeight, startHeight + moved)}px`;
      } else return;
      e.preventDefault();
      sheet.dataset['pull'] = 'true';
    },
    { passive: false },
  );
  listen(grip, 'touchend', () => {
    const was = mode;
    const passed = moved > (was === 'up' ? maxHeight - startHeight : startHeight) * SHEET_DISMISS_RATIO;
    settle();
    if (!passed) return;
    if (was === 'up') expand?.setExpanded(true);
    else if (was === 'down') {
      if (expand?.expanded()) expand.setExpanded(false);
      else close();
    }
  });
  listen(grip, 'touchcancel', settle);
}
