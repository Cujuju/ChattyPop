// A long list asks for a picture only once it can be seen: in view, with the list not flying past. A fling used to ask
// for every picture it passed, and those in view at rest waited behind thousands.
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
const { createRoot } = await import('solid-js');
// A variable path keeps the renderer module out of the node type-check.
const loadingPath = '../src/renderer/src/ui/seenLoading';
const { createSeenLoading } = (await import(loadingPath)) as {
  createSeenLoading(list: () => unknown): { whenSeen(picture: unknown, start: () => void): void };
};

type Seen = (entries: { target: unknown; isIntersecting: boolean }[]) => void;
/** The page as the list reads it: its view observer, clock and frames. */
const page = { seen: undefined as Seen | undefined, watched: new Set<unknown>(), now: 0, frames: new Map<number, () => void>(), nextFrame: 1 };
Object.assign(globalThis, {
  IntersectionObserver: class {
    constructor(seen: Seen) {
      page.seen = seen;
    }
    observe = (el: unknown) => void page.watched.add(el);
    unobserve = (el: unknown) => void page.watched.delete(el);
    disconnect = () => page.watched.clear();
  },
  requestAnimationFrame: (run: () => void) => {
    page.frames.set(page.nextFrame, run);
    return page.nextFrame++;
  },
  cancelAnimationFrame: (id: number) => void page.frames.delete(id),
});
vi.stubGlobal('performance', { now: () => page.now });

const LIST_PX = 600;
const FRAME_MS = 16;
/** One frame passes with no scroll event. */
const frame = (): void => {
  page.now += FRAME_MS;
  const due = [...page.frames.values()];
  page.frames.clear();
  for (const run of due) run();
};
/** The pictures are watched: the list's element exists. */
const watched = (): Promise<void> => Promise.resolve();
const comesIntoView = (picture: unknown): void => page.seen!([{ target: picture, isIntersecting: true }]);
const leavesView = (picture: unknown): void => page.seen!([{ target: picture, isIntersecting: false }]);

/** A list with one picture waiting; `scroll` moves it `px` in one frame. */
function listWithPicture() {
  const heard = new Set<() => void>();
  const list = {
    scrollTop: 0,
    clientHeight: LIST_PX,
    addEventListener: (_type: string, hear: () => void) => void heard.add(hear),
    removeEventListener: (_type: string, hear: () => void) => void heard.delete(hear),
  };
  const picture = {};
  const start = vi.fn();
  const dispose = createRoot((dispose) => {
    createSeenLoading(() => list).whenSeen(picture, start);
    return dispose;
  });
  const scroll = (px: number): void => {
    page.now += FRAME_MS;
    list.scrollTop += px;
    heard.forEach((hear) => hear());
  };
  return { picture, start, dispose, scroll };
}
/** A view crosses in a quarter second: flying. */
const FLYING_PX = (LIST_PX * 4 * FRAME_MS) / 1000;
/** A view crosses in two seconds: reading speed. */
const SLOW_PX = (LIST_PX * 0.5 * FRAME_MS) / 1000;

beforeEach(() => {
  page.frames.clear();
  page.now += 60_000;
});

describe('seen loading', () => {
  it('asks for a picture when it comes into view of a list at rest, once', async () => {
    const { picture, start } = listWithPicture();
    await watched();
    expect(start).not.toHaveBeenCalled();
    comesIntoView(picture);
    comesIntoView(picture);
    expect(start).toHaveBeenCalledTimes(1);
    expect(page.watched.has(picture)).toBe(false);
  });

  it('asks for a picture that comes into view of a slowly scrolling list', async () => {
    const { picture, start, scroll } = listWithPicture();
    await watched();
    scroll(SLOW_PX);
    scroll(SLOW_PX);
    comesIntoView(picture);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('asks for none of what a fling passes', async () => {
    const { picture, start, scroll } = listWithPicture();
    await watched();
    scroll(FLYING_PX);
    scroll(FLYING_PX);
    comesIntoView(picture);
    scroll(FLYING_PX);
    leavesView(picture);
    scroll(SLOW_PX);
    frame();
    frame();
    expect(start).not.toHaveBeenCalled();
  });

  it('asks for what is in view once the fling slows', async () => {
    const { picture, start, scroll } = listWithPicture();
    await watched();
    scroll(FLYING_PX);
    scroll(FLYING_PX);
    comesIntoView(picture);
    expect(start).not.toHaveBeenCalled();
    scroll(SLOW_PX);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('asks for what is in view when a finger stops the fling dead', async () => {
    const { picture, start, scroll } = listWithPicture();
    await watched();
    scroll(FLYING_PX);
    scroll(FLYING_PX);
    comesIntoView(picture);
    frame();
    expect(start).not.toHaveBeenCalled();
    frame();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('forgets a picture whose owner goes', async () => {
    const { picture, start, dispose } = listWithPicture();
    await watched();
    dispose();
    expect(page.watched.has(picture)).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });
});
