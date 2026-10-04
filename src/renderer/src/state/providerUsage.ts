// Each AI provider's plan limits: read when first asked for, re-read after completed work.
import { api } from '@/api';
import { createResource, createRoot, createSignal, type Accessor, type Resource } from 'solid-js';
import type { PlanUsageWindow } from '@shared/contract';
import type { ProviderId } from '@shared/settings';
import { onAppEvent } from './events';
import { failure, settled } from '@plugin-sdk/renderer/settled';

/** A provider's plan windows; null when it reports no plan limits. */
type Windows = PlanUsageWindow[] | null;

interface PlanRead {
  read: Resource<Windows>;
  refetch: () => unknown;
  /** The windows last read, kept while a refresh loads or after it fails. */
  last: Accessor<Windows | undefined>;
}

/** One read per provider asked about; each lives as long as the window. */
const reads = new Map<ProviderId, PlanRead>();

function readOf(id: ProviderId): PlanRead {
  let r = reads.get(id);
  if (!r) {
    r = createRoot(() => {
      const [last, setLast] = createSignal<Windows>();
      const [read, { refetch }] = createResource(async (): Promise<Windows> => {
        const windows = await api.core.aiPlanUsage(id);
        setLast(windows);
        return windows;
      });
      return { read, refetch, last };
    });
    reads.set(id, r);
  }
  return r;
}

/**
 * `id`'s plan windows (5-hour / weekly and the like), read on first call. Null when it reports no plan limits;
 * undefined while loading or after a failed read (planUsageFailureOf says why). Never throws. Reactive.
 */
export const planUsageOf = (id: ProviderId): Windows | undefined => settled(readOf(id).read);
/** Why `id`'s last plan-usage read failed; null while it didn't. Reactive. */
export const planUsageFailureOf = (id: ProviderId): string | null => failure(readOf(id).read);
/** Whether a plan-usage read of `id` is in flight. Reactive. */
export const planUsageLoadingOf = (id: ProviderId): boolean => readOf(id).read.loading;
/** `id`'s plan windows last read, kept while a refresh loads or after it fails; undefined before the first read. Reactive. */
export const lastPlanUsageOf = (id: ProviderId): Windows | undefined => readOf(id).last();

/** Re-reads `id`'s plan limits (after work it ran), or every provider's read so far. Unread providers stay unread. */
export function refetchPlanUsage(id?: ProviderId): void {
  for (const [provider, r] of reads) if (id === undefined || provider === id) void r.refetch();
}

/** Bumped when a plugin turns on or off: the plugins reporting ChattyPop's AI usage may have changed. Reactive. */
const [usageReporters, setUsageReporters] = createSignal(0);
export { usageReporters };

onAppEvent('plugins-changed', () => {
  setUsageReporters((n) => n + 1);
  refetchPlanUsage();
});
