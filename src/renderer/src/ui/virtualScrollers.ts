// Scrollers that a virtual log drives. Its distances are logical (they include a correction held while scrolling), and
// it is the only writer of its scroll offset, so scroll-edge reads and follow-bottom go through it.
import type { VirtualLogController } from '@cujuju/solidjs-virtual-log';

const logs = new WeakMap<Element, VirtualLogController<unknown>>();

export const registerVirtualScroller = (el: Element, log: VirtualLogController<unknown>): void => void logs.set(el, log);

/** The virtual log driving this scroller, if any. */
export const virtualScroller = (el: Element): VirtualLogController<unknown> | undefined => logs.get(el);
