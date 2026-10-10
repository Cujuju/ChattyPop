// Staged grids: a long list of emoji grids builds the cells in view first, then the rest a piece at a time between paints.
import { createSignal, onCleanup, onMount, type Accessor } from 'solid-js';
import { tokenPx } from '@/ui/format';
import { listen } from '@/ui/listen';

/** How far outside the list's view a grid is built ahead, in list heights above and below. */
const BUILD_AHEAD_VIEWS = 1;
/** BUILD_AHEAD_VIEWS as an observer's margin: a share of its root's height, above and below. */
const BUILD_AHEAD_MARGIN = `${BUILD_AHEAD_VIEWS * 100}% 0px`;

/**
 * Cells a grid builds in one piece, between two paints. About 11 ms on an iPhone (estimate: a list of 6,167 cells built
 * at once stalled it 330 ms), so a frame waits little; built a whole grid a paint, the largest stalled it 135 ms.
 */
export const CELLS_PER_PIECE = 200;

/**
 * How long after a touch lifts its tap's click may still come: iOS's double-tap wait. Content that appears as a tap lands
 * makes WebKit take the tap for a hover and withhold its click, so no piece is built until then.
 */
const TAP_LANDS_MS = 350;

/** Whether `grid` lies within BUILD_AHEAD_VIEWS of `list`'s view. */
function nearView(grid: Element, list: Element): boolean {
  const view = list.getBoundingClientRect();
  const box = grid.getBoundingClientRect();
  const ahead = view.height * BUILD_AHEAD_VIEWS;
  return box.bottom >= view.top - ahead && box.top <= view.bottom + ahead;
}

/** Columns `width` holds of a gapless grid's `cell`-wide tracks (`repeat(auto-fill, cell)`). */
export const gridColumns = (width: number, cell: number): number => (cell > 0 ? Math.max(1, Math.floor(width / cell)) : 1);

/** Rows `count` cells take in `columns`. */
export const gridRows = (count: number, columns: number): number => Math.ceil(count / columns);

export interface GridStaging {
  /** Columns each of the list's grids has. */
  columns: Accessor<number>;
  /**
   * Has `grid` built piece by piece: `piece` builds its next CELLS_PER_PIECE cells and tells whether it is now whole.
   * The first piece comes before the next paint when `grid` is already near the list's view, else when it nears it or
   * its turn comes; the rest follow one a paint. Owner-scoped.
   */
  watch(grid: Element, piece: () => boolean): void;
}

/**
 * Staging for the emoji grids of `list()`, a scroller. `sample()` is a grid always built, as wide as the rest: its
 * width gives the columns. Call from a component's body.
 */
export function createGridStaging(list: () => HTMLElement, sample: () => HTMLElement): GridStaging {
  const [columns, setColumns] = createSignal(1);
  const builds = new Map<Element, () => boolean>();
  /** Grids begun and not yet whole, the last begun last: they are finished ahead of those not begun. */
  const begun: Element[] = [];
  let nearing: IntersectionObserver | undefined;
  let checkQueued = false;
  const forget = (grid: Element): void => {
    builds.delete(grid);
    nearing?.unobserve(grid);
    const at = begun.indexOf(grid);
    if (at >= 0) begun.splice(at, 1);
  };
  /** Builds `grid`'s next piece. */
  const build = (grid: Element): void => {
    const piece = builds.get(grid);
    if (!piece) return;
    if (piece()) forget(grid);
    else if (!begun.includes(grid)) begun.push(grid);
  };
  /**
   * Builds the watched grids already near the view. The observer reports only after a paint, which would show them
   * empty first; this runs before it, once the grids not yet built hold their rows' height.
   */
  const buildNear = (): void => {
    checkQueued = false;
    for (const grid of [...builds.keys()]) if (nearView(grid, list())) build(grid);
    queueRest();
  };
  let restQueued = false;
  /**
   * Builds what is left, one piece after each paint: a grid begun first, then the rest in the order watched. Scrolling
   * finds them built, and no frame waits on more than one piece.
   */
  const buildRest = (): void => {
    restQueued = false;
    if (touched) return;
    const next = begun.at(-1) ?? builds.keys().next().value;
    if (next === undefined) return;
    build(next);
    queueRest();
  };
  const queueRest = (): void => {
    if (restQueued || !builds.size) return;
    restQueued = true;
    // A frame's callback runs before its paint; the task queued from it runs after.
    requestAnimationFrame(() => setTimeout(buildRest));
  };
  /** A finger is down, or its tap may still land: nothing is built between paints meanwhile (TAP_LANDS_MS). */
  let touched = false;
  let tapLands: ReturnType<typeof setTimeout> | undefined;
  const untouched = (): void => {
    clearTimeout(tapLands);
    touched = false;
    queueRest();
  };
  const lifted = (e: TouchEvent): void => {
    if (e.touches.length) return;
    clearTimeout(tapLands);
    tapLands = setTimeout(untouched, TAP_LANDS_MS);
  };
  listen(
    document,
    'touchstart',
    () => {
      clearTimeout(tapLands);
      touched = true;
    },
    { capture: true, passive: true },
  );
  listen(document, 'touchend', lifted, { capture: true, passive: true });
  listen(document, 'touchcancel', lifted, { capture: true, passive: true });
  // The tap landed: its click is being delivered, and the next piece comes after a paint.
  listen(document, 'click', untouched, { capture: true });
  onCleanup(() => clearTimeout(tapLands));
  onMount(() => {
    const measure = (): void => void setColumns(gridColumns(sample().clientWidth, tokenPx('--cp-picker-emoji')));
    measure();
    const resized = new ResizeObserver(measure);
    resized.observe(sample());
    onCleanup(() => resized.disconnect());
  });
  onCleanup(() => nearing?.disconnect());
  return {
    columns,
    watch(grid, piece) {
      nearing ??= new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting && build(e.target)), { root: list(), rootMargin: BUILD_AHEAD_MARGIN });
      builds.set(grid, piece);
      nearing.observe(grid);
      onCleanup(() => forget(grid));
      if (checkQueued) return;
      checkQueued = true;
      queueMicrotask(buildNear);
    },
  };
}
