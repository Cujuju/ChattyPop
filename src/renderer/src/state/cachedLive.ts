// Shows cached Discord answers immediately, replaces with live responses and retains stale cached values on failure.
import { ownedOrContained } from '@plugin-sdk/renderer/containment';
import { keyedResource } from './keyedResource';

export interface CachedLive<T> {
  /** The live answer once it arrives, else the cached one; null when neither exists yet. */
  value(): T | null;
  /** The live fetch failed: value() is the cached copy (or null). */
  stale(): boolean;
  /** The live fetch is still running. */
  loading(): boolean;
}

/** source keys cached/live reads; falsy sources show nothing. wantLive controls refresh from cached state, defaulting to always. */
export function cachedThenLive<S, T>(
  source: () => S | false | null | undefined,
  cached: (s: S) => Promise<T | null>,
  live: (s: S) => Promise<T>,
  wantLive: (cachedCopy: T | null, s: S) => boolean = () => true,
): CachedLive<T> {
  return ownedOrContained(() => {
    // Boxed: a copy of null (none cached) is an answer, unlike a copy still loading.
    const copy = keyedResource(source, async (s) => ({ v: await cached(s).catch(() => null) }));
    // Waits for this source's cached copy, so wantLive can judge it.
    const liveSource = (): S | false => {
      const s = source();
      const c = copy();
      return !!s && c !== undefined && wantLive(c.v, s) && s;
    };
    const fresh = keyedResource(liveSource, live);
    return {
      value: () => fresh() ?? copy()?.v ?? null,
      stale: () => fresh.failure !== null,
      loading: () => fresh.loading,
    };
  });
}
