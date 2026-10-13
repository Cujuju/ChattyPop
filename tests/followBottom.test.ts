// A list following its newest row keeps it in view as rows arrive or grow, but a row the reader's own click resized
// (one unfolding) holds the view still: what they clicked stays put and grows downwards.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
const { createRoot } = await import('solid-js');
// A variable path keeps the renderer module out of the node type-check.
const followPath = '../src/renderer/src/ui/followBottom';
const { createFollowBottom } = (await import(followPath)) as {
  createFollowBottom(): { ref(el: unknown): void; following(): boolean };
};

/** The page: the test delivers the resizes and frames it would. */
const page = { resized: (): void => undefined, frames: [] as (() => void)[] };
Object.assign(globalThis, {
  ResizeObserver: class {
    constructor(resized: () => void) {
      page.resized = resized;
    }
    observe = () => undefined;
    unobserve = () => undefined;
    disconnect = () => undefined;
  },
  MutationObserver: class {
    observe = () => undefined;
    disconnect = () => undefined;
  },
  requestAnimationFrame: (run: () => void) => page.frames.push(run),
  getComputedStyle: () => ({ flexDirection: 'column' }),
});
/** A frame: its animation callbacks; those they ask for wait for the next. */
const frame = (): void => void page.frames.splice(0).forEach((run) => run());

const VIEW_PX = 400;
const ROWS_PX = 1000;
/** A run unfolding: far more than the distance that still counts as at the newest. */
const UNFOLDED_PX = 600;
/** A row's sources opening: a line, within that distance. */
const LINE_PX = 40;

/** A list scrolled to its newest row and following it; `grow` lengthens a row and tells the list. */
function followedList() {
  const heard = new Map<string, () => void>();
  const el = {
    scrollTop: ROWS_PX - VIEW_PX,
    scrollHeight: ROWS_PX,
    clientHeight: VIEW_PX,
    children: [],
    addEventListener: (type: string, hear: () => void) => void heard.set(type, hear),
    removeEventListener: (type: string) => void heard.delete(type),
  };
  const { log, dispose } = createRoot((dispose) => {
    const log = createFollowBottom();
    log.ref(el);
    return { log, dispose };
  });
  const grow = (px: number): void => {
    el.scrollHeight += px;
    page.resized();
  };
  const fromBottom = (): number => el.scrollHeight - el.clientHeight - el.scrollTop;
  return { el, log, dispose, grow, fromBottom, click: () => heard.get('click')!() };
}

describe('follow bottom', () => {
  it('keeps the newest row in view as a row grows', () => {
    const list = followedList();
    list.grow(UNFOLDED_PX);
    expect(list.fromBottom()).toBe(0);
    expect(list.log.following()).toBe(true);
    list.dispose();
  });

  it('holds the view still when the reader unfolds a row, and stops following', () => {
    const list = followedList();
    const top = list.el.scrollTop;
    list.click();
    list.grow(UNFOLDED_PX);
    expect(list.el.scrollTop).toBe(top);
    expect(list.log.following()).toBe(false);
    list.dispose();
  });

  it('holds the view still for a small unfolding too, and follows the next arrival', () => {
    const list = followedList();
    const top = list.el.scrollTop;
    list.click();
    list.grow(LINE_PX);
    expect(list.el.scrollTop).toBe(top);
    expect(list.log.following()).toBe(true);
    // The click's frame, then the one after it: later growth is an arrival again.
    frame();
    frame();
    list.grow(LINE_PX);
    expect(list.fromBottom()).toBe(0);
    list.dispose();
  });

  it('follows a row that arrives in the frames after a click that resized nothing', () => {
    const list = followedList();
    list.click();
    frame();
    frame();
    list.grow(UNFOLDED_PX);
    expect(list.fromBottom()).toBe(0);
    list.dispose();
  });
});
