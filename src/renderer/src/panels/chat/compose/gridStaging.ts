// Staged grids: a long list of emoji grids builds the cells in view first, then the rest a grid at a time between paints.
import { createSignal, onCleanup, onMount, type Accessor } from 'solid-js';
import { tokenPx } from '@/ui/format';

/** How far outside the list's view a grid is built ahead, in list heights above and below. */
const BUILD_AHEAD_VIEWS = 1;
/** BUILD_AHEAD_VIEWS as an observer's margin: a share of its root's height, above and below. */
const BUILD_AHEAD_MARGIN = `${BUILD_AHEAD_VIEWS * 100}% 0px`;

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
   * Calls `build` once: before the next paint when `grid` is already near the list's view, else when it nears it or its
   * turn comes among the grids built between paints. Owner-scoped.
   */
  watch(grid: Element, build: () => void): void;
}

/**
 * Staging for the emoji grids of `list()`, a scroller. `sample()` is a grid always built, as wide as the rest: its
 * width gives the columns. Call from a component's body.
 */
export function createGridStaging(list: () => HTMLElement, sample: () => HTMLElement): GridStaging {
  const [columns, setColumns] = createSignal(1);
  const builds = new Map<Element, () => void>();
  let nearing: IntersectionObserver | undefined;
  let checkQueued = false;
  const build = (grid: Element): void => {
    const run = builds.get(grid);
    builds.delete(grid);
    nearing?.unobserve(grid);
    run?.();
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
   * Builds the grids left, in the order watched, one after each paint: scrolling finds them built, and no frame waits
   * on more than one grid.
   */
  const buildRest = (): void => {
    restQueued = false;
    const next = builds.keys().next();
    if (next.done) return;
    build(next.value);
    queueRest();
  };
  const queueRest = (): void => {
    if (restQueued || !builds.size) return;
    restQueued = true;
    // A frame's callback runs before its paint; the task queued from it runs after.
    requestAnimationFrame(() => setTimeout(buildRest));
  };
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
    watch(grid, run) {
      nearing ??= new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting && build(e.target)), { root: list(), rootMargin: BUILD_AHEAD_MARGIN });
      builds.set(grid, run);
      nearing.observe(grid);
      onCleanup(() => {
        builds.delete(grid);
        nearing?.unobserve(grid);
      });
      if (checkQueued) return;
      checkQueued = true;
      queueMicrotask(buildNear);
    },
  };
}
