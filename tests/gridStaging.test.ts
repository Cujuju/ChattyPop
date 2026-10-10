// A long emoji list builds a grid's cells only once it nears the view, and holds its rows' height until then: the
// phone's picker used to build every server's emoji before showing the first.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const CELL_PX = 36;
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
vi.mock('@/ui/format', () => ({ tokenPx: () => CELL_PX }));
const { createRoot } = await import('solid-js');
// A variable path keeps the renderer module out of the node type-check.
const stagingPath = '../src/renderer/src/panels/chat/compose/gridStaging';
const { createGridStaging, gridColumns, gridRows } = (await import(stagingPath)) as {
  createGridStaging(list: () => unknown, sample: () => unknown): { columns: () => number; watch(grid: unknown, build: () => void): void };
  gridColumns(width: number, cell: number): number;
  gridRows(count: number, columns: number): number;
};

type Seen = (entries: { target: unknown; isIntersecting: boolean }[]) => void;
/** The observers the page would run: the test delivers what they would see. */
const page = { seen: undefined as Seen | undefined, resized: undefined as (() => void) | undefined, watched: new Set<unknown>() };
Object.assign(globalThis, {
  IntersectionObserver: class {
    constructor(seen: Seen) {
      page.seen = seen;
    }
    observe = (el: unknown) => void page.watched.add(el);
    unobserve = (el: unknown) => void page.watched.delete(el);
    disconnect = () => page.watched.clear();
  },
  ResizeObserver: class {
    constructor(resized: () => void) {
      page.resized = resized;
    }
    observe = () => undefined;
    disconnect = () => undefined;
  },
});

/** A list whose sample grid is `width` wide, with one grid watched. */
function stagedList(width: number) {
  const sample = { clientWidth: width };
  const grid = {};
  const build = vi.fn();
  const { staging, dispose } = createRoot((dispose) => {
    const staging = createGridStaging(() => ({}), () => sample);
    staging.watch(grid, build);
    return { staging, dispose };
  });
  return { sample, grid, build, staging, dispose };
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
    const { sample, staging } = stagedList(9 * CELL_PX);
    expect(staging.columns()).toBe(9);
    sample.clientWidth = 12 * CELL_PX;
    page.resized!();
    expect(staging.columns()).toBe(12);
  });

  it('builds a grid once, when it nears the view', () => {
    const { grid, build } = stagedList(9 * CELL_PX);
    page.seen!([{ target: grid, isIntersecting: false }]);
    expect(build).not.toHaveBeenCalled();
    page.seen!([{ target: grid, isIntersecting: true }]);
    page.seen!([{ target: grid, isIntersecting: true }]);
    expect(build).toHaveBeenCalledTimes(1);
    expect(page.watched.has(grid)).toBe(false);
  });

  it('stops watching when its owner goes', () => {
    const { grid, dispose } = stagedList(9 * CELL_PX);
    expect(page.watched.has(grid)).toBe(true);
    dispose();
    expect(page.watched.has(grid)).toBe(false);
  });
});
