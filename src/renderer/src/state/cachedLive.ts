// A Discord answer the archive caches: the cached copy shows at once, a live fetch replaces it, and when the
// fetch fails the cached copy stays, marked stale so the view can say how old it is.
import { createResource } from 'solid-js';

export interface CachedLive<T> {
  /** The live answer once it arrives, else the cached one; null when neither exists yet. */
  value(): T | null;
  /** The live fetch failed: value() is the cached copy (or null). */
  stale(): boolean;
  /** The live fetch is still running. */
  loading(): boolean;
}

/** An answer with the request it answers: a resource keeps its last value while the next loads, which may be another's. */
interface Answer<S, T> {
  s: S;
  v: T | null;
}

/**
 * `source` keys both reads (falsy: nothing to show). `live` runs only when `wantLive` says so for the cached copy
 * (default: always), e.g. when a cached reactor list's count no longer matches.
 */
export function cachedThenLive<S, T>(
  source: () => S | false | null | undefined,
  cached: (s: S) => Promise<T | null>,
  live: (s: S) => Promise<T>,
  wantLive: (cachedCopy: T | null, s: S) => boolean = () => true,
): CachedLive<T> {
  const [copy] = createResource(source, async (s): Promise<Answer<S, T>> => ({ s, v: await cached(s).catch(() => null) }));
  // Waits for this request's cached copy, so wantLive can judge it.
  const liveSource = (): S | false => {
    const s = source();
    const c = copy.state === 'ready' ? copy() : undefined;
    return !!s && c?.s === s && wantLive(c.v, s) && s;
  };
  const [fresh] = createResource(liveSource, async (s): Promise<Answer<S, T>> => ({ s, v: await live(s) }));
  const current = (a: Answer<S, T> | undefined): T | null => (a && a.s === source() ? a.v : null);
  return {
    value: () => current(fresh.state === 'ready' ? fresh() : undefined) ?? current(copy.state === 'ready' ? copy() : undefined),
    stale: () => fresh.state === 'errored' && liveSource() !== false,
    loading: () => fresh.loading,
  };
}
