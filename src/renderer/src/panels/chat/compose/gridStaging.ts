// Staged grids: a long list of emoji grids builds each one's cells only as it nears the list's view.
import { createSignal, onCleanup, onMount, type Accessor } from 'solid-js';
import { tokenPx } from '@/ui/format';

/** How far outside the list's view a grid is built ahead: one list height above and below. */
const BUILD_AHEAD = '100% 0px';

/** Columns `width` holds of a gapless grid's `cell`-wide tracks (`repeat(auto-fill, cell)`). */
export const gridColumns = (width: number, cell: number): number => (cell > 0 ? Math.max(1, Math.floor(width / cell)) : 1);

/** Rows `count` cells take in `columns`. */
export const gridRows = (count: number, columns: number): number => Math.ceil(count / columns);

export interface GridStaging {
  /** Columns each of the list's grids has. */
  columns: Accessor<number>;
  /** Calls `build` once, when `grid` nears the list's view. Owner-scoped. */
  watch(grid: Element, build: () => void): void;
}

/**
 * Staging for the emoji grids of `list()`, a scroller. `sample()` is a grid always built, as wide as the rest: its
 * width gives the columns. Call from a component's body.
 */
export function createGridStaging(list: () => HTMLElement, sample: () => HTMLElement): GridStaging {
  const [columns, setColumns] = createSignal(1);
  const builds = new Map<Element, () => void>();
  let nearView: IntersectionObserver | undefined;
  onMount(() => {
    const measure = (): void => void setColumns(gridColumns(sample().clientWidth, tokenPx('--cp-picker-emoji')));
    measure();
    const resized = new ResizeObserver(measure);
    resized.observe(sample());
    onCleanup(() => resized.disconnect());
  });
  onCleanup(() => nearView?.disconnect());
  return {
    columns,
    watch(grid, build) {
      nearView ??= new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            nearView?.unobserve(e.target);
            builds.get(e.target)?.();
            builds.delete(e.target);
          }
        },
        { root: list(), rootMargin: BUILD_AHEAD },
      );
      builds.set(grid, build);
      nearView.observe(grid);
      onCleanup(() => {
        builds.delete(grid);
        nearView?.unobserve(grid);
      });
    },
  };
}
