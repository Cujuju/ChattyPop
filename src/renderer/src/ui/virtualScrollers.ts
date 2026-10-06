// Virtual logs own scroll-offset writes. Distance/follow-bottom reads use logical positions including held corrections.
import type { VirtualLogController } from '@cujuju/solidjs-virtual-log';

const logs = new WeakMap<Element, VirtualLogController<unknown>>();

export const registerVirtualScroller = (el: Element, log: VirtualLogController<unknown>): void => void logs.set(el, log);

/** The virtual log driving this scroller, if any. */
export const virtualScroller = (el: Element): VirtualLogController<unknown> | undefined => logs.get(el);
