// Pictures in a long scrolling list, asked for only while they can be seen: in view, with the list not flying past.
import { onCleanup, onMount } from 'solid-js';
import { MS_PER_S } from '@shared/units';
import { listen } from './listen';

/**
 * Views a second past which the list is flying: a picture crosses the view in under half a second, too fast to pick out
 * (an estimate). Every picture that passed used to be asked for, and a phone fetches a few at a time, so those in view at
 * rest waited behind the rest (measured on an iPhone: 2,500 asked for in 1.5 s of a fling; requests then took over 7 s).
 */
const FLYING_VIEWS_PER_S = 2;
/** Frames without a scroll event after which the list has stopped: a finger can halt a fling between two events. */
const STOPPED_AFTER_FRAMES = 2;

export interface SeenLoading {
  /** Calls `start` once, when `picture` is in the list's view and the list isn't flying past it. Owner-scoped. */
  whenSeen(picture: Element, start: () => void): void;
}

/** Seen-loading for the pictures of `list()`, a scroller. Call from a component's body. */
export function createSeenLoading(list: () => HTMLElement): SeenLoading {
  /** Pictures not started yet, and those of them in view. */
  const starts = new Map<Element, () => void>();
  const inView = new Set<Element>();
  let views: IntersectionObserver | undefined;
  let flying = false;
  const forget = (picture: Element): void => {
    starts.delete(picture);
    inView.delete(picture);
    views?.unobserve(picture);
  };
  const start = (picture: Element): void => {
    const run = starts.get(picture);
    forget(picture);
    run?.();
  };
  const startSeen = (): void => {
    for (const picture of [...inView]) start(picture);
  };
  const watch = (picture: Element): void => {
    views ??= new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) inView.delete(e.target);
          else if (flying) inView.add(e.target);
          else start(e.target);
        }
      },
      { root: list() },
    );
    views.observe(picture);
  };

  let lastTop = 0;
  let lastAt = 0;
  let stopCheck: number | undefined;
  const onScroll = (): void => {
    const el = list();
    const now = performance.now();
    // The first event after a rest has a long gap behind it, so it reads as slow.
    const perSecond = (Math.abs(el.scrollTop - lastTop) / Math.max(1, now - lastAt)) * MS_PER_S;
    lastTop = el.scrollTop;
    lastAt = now;
    flying = perSecond > el.clientHeight * FLYING_VIEWS_PER_S;
    if (!flying) startSeen();
    if (stopCheck !== undefined) cancelAnimationFrame(stopCheck);
    let frames = 0;
    const stopped = (): void => {
      if (++frames < STOPPED_AFTER_FRAMES) return void (stopCheck = requestAnimationFrame(stopped));
      stopCheck = undefined;
      flying = false;
      startSeen();
    };
    stopCheck = requestAnimationFrame(stopped);
  };
  onMount(() => listen(list(), 'scroll', onScroll, { passive: true }));
  onCleanup(() => {
    views?.disconnect();
    if (stopCheck !== undefined) cancelAnimationFrame(stopCheck);
  });
  return {
    whenSeen(picture, run) {
      starts.set(picture, run);
      // Watched once the list's element exists: a picture drawn with the list is made before it.
      queueMicrotask(() => starts.has(picture) && watch(picture));
      onCleanup(() => forget(picture));
    },
  };
}
