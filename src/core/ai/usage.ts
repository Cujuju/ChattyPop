// Active plugins' completed AI work, summed for the provider usage panel.
import type { AppUsage } from '@shared/contract';
import type { ProviderId } from '@shared/settings';

/** Completed runs and tokens since a provider window began. */
export type UsageReader = (provider: ProviderId, sinceTs: number) => AppUsage;
const readers = new Set<UsageReader>();

/** Registers one owner until disposal. */
export function registerUsage(read: UsageReader): () => void {
  readers.add(read);
  return () => { readers.delete(read); };
}

/** Adds completed work from every active owner. */
export function usageSince(provider: ProviderId, sinceTs: number): AppUsage {
  const total: AppUsage = {
    runs: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  for (const read of readers) {
    const value = read(provider, sinceTs);
    total.runs += value.runs;
    total.inputTokens += value.inputTokens;
    total.cachedInputTokens += value.cachedInputTokens;
    total.outputTokens += value.outputTokens;
  }
  return total;
}
