// A long emoji list builds the cells its view shows before the first paint, then more only as scrolling nears them, and
// holds each grid's full height meanwhile. Nothing is built while the list rests: cells appearing as a tap landed made
// iOS withhold the tap's click.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const CELL_PX = 36;
const COLUMNS = 9;
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
vi.mock('@/ui/format', () => ({ tokenPx: () => CELL_PX }));
const { createRoot } = await import('solid-js');
// A variable path keeps the renderer module out of the node type-check.
const stagingPath = '../src/renderer/src/panels/chat/compose/gridStaging';
const { CELLS_PER_PIECE, createGridStaging, gridColumns, gridRows } = (await import(stagingPath)) as {
  CELLS_PER_PIECE: number;
  createGridStaging(list: () => unknown, sample: () => unknown): { columns: () => number; watch(grid: unknown, piece: () => boolean): void };
  gridColumns(width: number, cell: number): number;
  gridRows(count: number, columns: number): number;
};

/** The page's resize observer: the test delivers what it would see. */
const page = { resized: undefined as (() => void) | undefined };
Object.assign(globalThis, {
  ResizeObserver: class {
    constructor(resized: () => void) {
      page.resized = resized;
    }
    observe = () => undefined;
    disconnect = () => undefined;
  },
});

const LIST_PX = 300;
/** The list's view and the one list height built ahead of it end here. */
const NEAR_END_PX = 2 * LIST_PX;
/** The checks queued for before the next paint have run. */
const beforePaint = (): Promise<void> => Promise.resolve();

/** A grid of `cells`, its top `top` px under the list's top; `scrollBy` moves it as the list scrolling would. */
function grid(cells: number, top: number) {
  const place = { top };
  const piece = vi.fn(() => piece.mock.calls.length * CELLS_PER_PIECE >= cells);
  const height = gridRows(cells, COLUMNS) * CELL_PX;
  return { piece, place, el: { getBoundingClientRect: () => ({ top: place.top, bottom: place.top + height, height }) } };
}

/** A list with `grids` watched, its sample grid COLUMNS wide; `scroll` moves the grids up and tells the list. */
function stagedList(...grids: ReturnType<typeof grid>[]) {
  const sample = { clientWidth: COLUMNS * CELL_PX };
  const heard = new Set<() => void>();
  const list = {
    getBoundingClientRect: () => ({ top: 0, bottom: LIST_PX, height: LIST_PX }),
    addEventListener: (_type: string, hear: () => void) => void heard.add(hear),
    removeEventListener: (_type: string, hear: () => void) => void heard.delete(hear),
  };
  const { staging, dispose } = createRoot((dispose) => {
    const staging = createGridStaging(() => list, () => sample);
    for (const g of grids) staging.watch(g.el, g.piece);
    return { staging, dispose };
  });
  const scroll = (px: number): void => {
    for (const g of grids) g.place.top -= px;
    heard.forEach((hear) => hear());
  };
  return { sample, staging, dispose, scroll };
}

describe('grid staging', () => {
  it('counts the columns and rows a gapless grid lays out', () => {
    expect(gridColumns(9 * CELL_PX + CELL_PX - 1, CELL_PX)).toBe(9);
    expect(gridColumns(0, CELL_PX)).toBe(1);
    expect(gridColumns(400, 0)).toBe(1);
    expect(gridRows(19, 9)).toBe(3);
    expect(gridRows(18, 9)).toBe(2);
    expect(gridRows(0, 9)).toBe(0);
  });

  it('takes its columns from the sample grid, and again when it resizes', () => {
    const { sample, staging } = stagedList();
    expect(staging.columns()).toBe(COLUMNS);
    sample.clientWidth = 12 * CELL_PX;
    page.resized!();
    expect(staging.columns()).toBe(12);
  });

  it('builds a grid in view before the next paint, whole when it is small', async () => {
    const small = grid(CELLS_PER_PIECE / 2, 0);
    stagedList(small);
    expect(small.piece).not.toHaveBeenCalled();
    await beforePaint();
    expect(small.piece).toHaveBeenCalledTimes(1);
  });

  it('builds of a large grid only the pieces the view nears', async () => {
    const large = grid(10 * CELLS_PER_PIECE, 0);
    stagedList(large);
    await beforePaint();
    // Pieces are built while the first cell not built lies within the view and the height ahead of it.
    const rowsPerPiece = Math.floor(CELLS_PER_PIECE / COLUMNS);
    const piecesNear = Math.floor(NEAR_END_PX / (rowsPerPiece * CELL_PX)) + 1;
    expect(large.piece).toHaveBeenCalledTimes(piecesNear);
  });

  it('builds nothing more while the list rests', async () => {
    const large = grid(10 * CELLS_PER_PIECE, 0);
    const far = grid(CELLS_PER_PIECE, NEAR_END_PX + large.el.getBoundingClientRect().height);
    stagedList(large, far);
    await beforePaint();
    const built = large.piece.mock.calls.length;
    await new Promise((later) => setTimeout(later, 50));
    expect(large.piece).toHaveBeenCalledTimes(built);
    expect(far.piece).not.toHaveBeenCalled();
  });

  it('builds the next piece as scrolling nears it', async () => {
    const large = grid(10 * CELLS_PER_PIECE, 0);
    const { scroll } = stagedList(large);
    await beforePaint();
    const built = large.piece.mock.calls.length;
    scroll(Math.floor(CELLS_PER_PIECE / COLUMNS) * CELL_PX);
    expect(large.piece).toHaveBeenCalledTimes(built + 1);
  });

  it('builds a far grid once scrolling brings it near, and it is then left alone', async () => {
    const far = grid(CELLS_PER_PIECE / 2, NEAR_END_PX + 1);
    const { scroll } = stagedList(far);
    await beforePaint();
    expect(far.piece).not.toHaveBeenCalled();
    scroll(1);
    expect(far.piece).toHaveBeenCalledTimes(1);
    scroll(1);
    expect(far.piece).toHaveBeenCalledTimes(1);
  });

  it('builds what a taller list shows (a sheet pulled up)', async () => {
    const far = grid(CELLS_PER_PIECE / 2, NEAR_END_PX + 1);
    stagedList(far);
    await beforePaint();
    far.place.top = NEAR_END_PX;
    page.resized!();
    expect(far.piece).toHaveBeenCalledTimes(1);
  });

  it('stops building when its owner goes', async () => {
    const far = grid(CELLS_PER_PIECE / 2, NEAR_END_PX + 1);
    const { dispose, scroll } = stagedList(far);
    await beforePaint();
    dispose();
    scroll(LIST_PX);
    expect(far.piece).not.toHaveBeenCalled();
  });
});
