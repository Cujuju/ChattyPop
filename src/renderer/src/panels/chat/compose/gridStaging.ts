// Staged grids: a long list of emoji grids builds the cells its view shows first, then the rest as scrolling nears them.
import { createSignal, onCleanup, onMount, type Accessor } from 'solid-js';
import { tokenPx } from '@/ui/format';
import { listen } from '@/ui/listen';

/** How far outside the list's view cells are built ahead, in list heights above and below. */
const BUILD_AHEAD_VIEWS = 1;
/** Cells a grid builds at a time: the owner's choice. About 5 ms on an iPhone (estimate: 6,167 built at once stalled it 330 ms). */
export const CELLS_PER_PIECE = 100;
/** The emoji cell's side: a grid's column width and its row height. */
const CELL_TOKEN = '--cp-picker-emoji';

/** Columns `width` holds of a gapless grid's `cell`-wide tracks (`repeat(auto-fill, cell)`). */
export const gridColumns = (width: number, cell: number): number => (cell > 0 ? Math.max(1, Math.floor(width / cell)) : 1);

/** Rows `count` cells take in `columns`. */
export const gridRows = (count: number, columns: number): number => Math.ceil(count / columns);

export interface GridStaging {
  /** Columns each of the list's grids has. */
  columns: Accessor<number>;
  /**
   * Has `grid` built piece by piece, from its top: `piece` builds its next CELLS_PER_PIECE cells and tells whether it is
   * now whole. A piece comes when the list's view nears the cells it holds: before the next paint for those in view, then
   * as the list scrolls or grows. Nothing is built otherwise: content that appears as a tap lands makes iOS withhold the
   * tap's click (measured: every tap during building lost it). Owner-scoped.
   */
  watch(grid: Element, piece: () => boolean): void;
}

/**
 * Staging for the emoji grids of `list()`, a scroller. `sample()` is a grid always built, as wide as the rest: its
 * width gives the columns. Call from a component's body.
 */
export function createGridStaging(list: () => HTMLElement, sample: () => HTMLElement): GridStaging {
  const [columns, setColumns] = createSignal(1);
  /** Each watched grid's builder, and the cells it has built. */
  const builds = new Map<Element, { piece: () => boolean; built: number }>();
  let checkQueued = false;
  /**
   * Builds every piece the view is near. Every place is read first, then the pieces are built: a grid not yet whole
   * holds its full height, so building moves nothing.
   */
  const buildNear = (): void => {
    checkQueued = false;
    if (!builds.size) return;
    const cell = tokenPx(CELL_TOKEN);
    const view = list().getBoundingClientRect();
    const ahead = view.height * BUILD_AHEAD_VIEWS;
    const near = [...builds]
      .map(([grid, build]) => ({ grid, build, box: grid.getBoundingClientRect() }))
      .filter(({ box }) => box.bottom >= view.top - ahead && box.top <= view.bottom + ahead);
    for (const { grid, build, box } of near) {
      // The first cell not built lies under the rows filled so far.
      while (box.top + Math.floor(build.built / columns()) * cell <= view.bottom + ahead) {
        build.built += CELLS_PER_PIECE;
        if (!build.piece()) continue;
        builds.delete(grid);
        break;
      }
    }
  };
  onMount(() => {
    const measure = (): void => void setColumns(gridColumns(sample().clientWidth, tokenPx(CELL_TOKEN)));
    measure();
    // A wider list has other columns; a taller one (a sheet pulled up) shows more.
    const resized = new ResizeObserver(() => {
      measure();
      buildNear();
    });
    resized.observe(sample());
    resized.observe(list());
    onCleanup(() => resized.disconnect());
    listen(list(), 'scroll', buildNear, { passive: true });
  });
  return {
    columns,
    watch(grid, piece) {
      builds.set(grid, { piece, built: 0 });
      onCleanup(() => builds.delete(grid));
      if (checkQueued) return;
      checkQueued = true;
      // After the grids just made hold their rows' height, and before the paint that would show them empty.
      queueMicrotask(buildNear);
    },
  };
}
