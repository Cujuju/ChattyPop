import type { Accessor } from 'solid-js';
import { createVirtualLog as createLog, type Align, type VirtualLogController } from '@cujuju/solidjs-virtual-log';
import { tokenPx } from './format';
import { registerVirtualScroller } from './virtualScrollers';

export interface VirtualLog<R extends { key: string }> {
  rows: Accessor<R[]>;
  /** The row with this key. */
  rowByKey: (key: string) => R | undefined;
  /** Ref for the scroll container. */
  ref: (el: HTMLDivElement) => void;
  /** Scroll handler: near the top, loads older rows; near the bottom, newer ones (hasNewer). */
  onScroll: () => Promise<void>;
  /** Brings the row with this key into view, if it's in the log. */
  scrollToKey: (key: string) => void;
  /** Centers a keyed row (or holds it at `align`, a place bottomOf read) until user scrolling/removal. null releases; missing keys return false. */
  holdRow: (key: string | null, align?: Align) => boolean;
  /** A row is held (holdRow) and the user hasn't scrolled since. */
  holding: Accessor<boolean>;
  /** The canvas height: the rows' total (plus a runway while older rows remain), changed only at rest. */
  extent: Accessor<number>;
  /** The toolkit log underneath (VirtualRows draws it). */
  log: VirtualLogController<R>;
}

/** Bottom-anchored chronological virtualization loads older pages near top. Measures drawn rows from estimates and avoids offset writes during scrolling to preserve iOS momentum. */
export function createVirtualLog<R extends { key: string }>(o: {
  rows: Accessor<R[]>;
  /** Height guess before a row is measured: one for all rows, or per row. */
  estimatePx: number | ((row: R) => number);
  /** Load older rows when the top is within this many rows. */
  olderThresholdRows: number;
  /** Prepends older rows. */
  loadOlder: () => Promise<unknown>;
  /** The view follows the newest row (followBottom): rows changing height keep it on the newest, else its top edge still. */
  following: () => boolean;
  /** Older rows remain to load: a runway above the oldest lets a fling run on while they do. */
  hasOlder?: () => boolean;
  /** Newer rows remain to load (opened around an older row): `loadNewer` appends them as the bottom nears. */
  hasNewer?: () => boolean;
  loadNewer?: () => Promise<unknown>;
  /** Changing it (density) marks row measurements stale. */
  layoutKey?: () => unknown;
  /** Space under the newest row (default --cp-log-end-pad): what lies over the log's bottom, where something does (the composer), as it changes. */
  endPadPx?: number | Accessor<number>;
}): VirtualLog<R> {
  const log = createLog<R>({
    rows: o.rows,
    estimateSize: o.estimatePx,
    // Space under the newest row, kept when scrolling to it, so it never sits against the panel's edge.
    endPadding: o.endPadPx ?? tokenPx('--cp-log-end-pad'),
    following: o.following,
    hasOlder: o.hasOlder,
    loadOlder: o.loadOlder,
    olderThreshold: o.olderThresholdRows,
    hasNewer: o.hasNewer,
    loadNewer: o.loadNewer,
    layoutKey: o.layoutKey,
  });
  return {
    rows: o.rows,
    rowByKey: log.rowByKey,
    ref: (el) => {
      registerVirtualScroller(el, log as VirtualLogController<unknown>);
      log.ref(el);
    },
    onScroll: async () => void (await Promise.all([log.checkOlder(), log.checkNewer()])),
    scrollToKey: (key) => void log.scrollToKey(key),
    holdRow: log.holdRow,
    holding: log.holding,
    extent: log.extent,
    log,
  };
}
