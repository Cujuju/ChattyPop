// Plugin SDK, renderer: the reads a window's first paint waits for, so it opens on stored state, never on fallbacks swapped out a moment later.

const held: Promise<unknown>[] = [];
let released = false;

/** Holds the first paint until `read` settles. A read begun after release (a plugin loaded later) adopts its value on arrival. */
export function holdFirstPaint(read: Promise<unknown>): void {
  if (!released) held.push(read);
}

/** Settles once every held read has, failed ones included (they keep their fallbacks). Releases the hold: later reads don't join. */
export function firstPaintReady(): Promise<void> {
  released = true;
  return Promise.allSettled(held).then(() => undefined);
}
