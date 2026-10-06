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

/** Reactively reads provider plan windows once. null means no limits; undefined means loading/failure. Never throws; failures have separate diagnostics. */
export const planUsageOf = (id: ProviderId): Windows | undefined => settled(readOf(id).read);
/** Reactive last plan-usage error, or null. */
export const planUsageFailureOf = (id: ProviderId): string | null => failure(readOf(id).read);
/** Whether a plan-usage read of `id` is in flight. Reactive. */
export const planUsageLoadingOf = (id: ProviderId): boolean => readOf(id).read.loading;
/** Reactive cached plan windows survive refresh/loading errors; undefined before first read. */
export const lastPlanUsageOf = (id: ProviderId): Windows | undefined => readOf(id).last();

/** Refreshes one provider or all previously read providers, leaving unread providers untouched. */
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
