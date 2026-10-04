// Named unread sources shared by host features and bundled plugins, without importing the plugin registry.
import { oneOf } from '@shared/normalize';
import { DEFAULT_UNREAD_KIND, NO_UNREAD, UNREAD_KINDS, type UnreadSource, type UnreadTotals } from '@shared/unread';

type Sources = readonly (readonly [string, UnreadSource])[];

/** A registry reads plugin sources lazily so Solid tracks both counts and enabled state in its caller. */
export function createUnreadCounts() {
  const host = new Map<string, UnreadSource>();
  let plugins: () => Sources = () => [];
  const sources = (): Map<string, UnreadSource> => {
    const all = new Map(host);
    for (const [id, source] of plugins()) {
      if (all.has(id)) throw new Error(`Duplicate unread source ${id}`);
      all.set(id, source);
    }
    return all;
  };
  const countOf = (source?: UnreadSource): number => {
    const count = source?.count() ?? 0;
    return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  };
  return {
    host: (id: string, source: UnreadSource): void => {
      if (host.has(id)) throw new Error(`Duplicate host unread source ${id}`);
      host.set(id, source);
    },
    plugins: (read: () => Sources): void => { plugins = read; },
    source: (id: string): UnreadSource | undefined => sources().get(id),
    count: (id: string): number => countOf(sources().get(id)),
    total: (): number => [...sources().values()].reduce((sum, source) => sum + countOf(source), 0),
    /** Counts summed per kind; a kind a plugin misnames counts as the default. */
    totals: (): UnreadTotals => {
      const totals: UnreadTotals = { ...NO_UNREAD };
      for (const source of sources().values()) totals[oneOf(UNREAD_KINDS, source.kind, DEFAULT_UNREAD_KIND)] += countOf(source);
      return totals;
    },
  };
}

/** Host wiring; plugin modules access only the readers exported by the SDK. */
export const unreadCounts = createUnreadCounts();
/** One feature's unread count, or zero while absent or off. */
export const unreadCount = unreadCounts.count;
/** All registered feature counts, summed once, whatever their kind. */
export const totalUnreadCount = unreadCounts.total;
/** Registered counts summed per kind: the taskbar and tray indicators. */
export const unreadTotals = unreadCounts.totals;
