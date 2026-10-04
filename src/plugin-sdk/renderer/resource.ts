// Plugin SDK, renderer: a plugin core call as a Solid resource (docs/plugin-architecture.md §5), settled against the
// window's audience, the plugin's switch and the deactivation race.
import { createResource, untrack, type ResourceOptions } from 'solid-js';
import type { ChannelsOf, PluginDescriptor } from '@shared/bundledTypes';
import type { MembersFor } from '@shared/pluginChannels';
import { coreClient, type WindowAudience, type WindowMember } from './clients';
import { callable } from './pluginList';
import { pluginData } from './data';
import { failure, settled } from './settled';

type Shapes<D> = MembersFor<ChannelsOf<D>, 'core', WindowAudience>;
type ArgsOf<D, K extends WindowMember<D>> = Shapes<D>[K] extends (...args: infer A) => unknown ? A : never;
type ResultOf<D, K extends WindowMember<D>> = Shapes<D>[K] extends (...args: never[]) => infer R ? Awaited<R> : never;

/** A core call's latest result, read like a signal. */
export interface PluginResource<T> {
  /** The result; the fallback before the first, while this window may not call the member, and after a failed read. Never throws. Reactive. */
  (): T;
  /** A read is in flight. Reactive. */
  readonly loading: boolean;
  /** Why the last read failed (not inactivity, which reads as the fallback); null while it didn't. Reactive. */
  readonly failure: string | null;
  /** Reads again with `args()` evaluated now; does nothing while the member isn't callable or `args` gives none. */
  refetch(): Promise<void>;
  /** Replaces the result until the next read (a value core pushed). */
  mutate(value: T): void;
}

/**
 * Core's `member` for this window, read with `args()` while it is callable (the plugin is on and the member serves this
 * window) and `args()` gives some; re-read when either changes. An inactive plugin's answer, or one arriving after it
 * turned off, reads as `fallback`; other failures keep their message in `failure`.
 */
export function pluginResource<const D extends PluginDescriptor, K extends WindowMember<D>, F>(
  plugin: D,
  member: K,
  // A spread tuple, so an array literal `args` returns is read as the member's argument tuple.
  args: () => [...ArgsOf<D, K>] | null | undefined | false,
  fallback: F,
  options: Pick<ResourceOptions<ResultOf<D, K> | F>, 'storage'> = {},
): PluginResource<ResultOf<D, K> | F> {
  type T = ResultOf<D, K> | F;
  const client = coreClient(plugin) as Record<string, ((...a: unknown[]) => Promise<unknown>) | undefined>;
  const on = (): boolean => callable(plugin, member);
  const read = async (a: unknown[]): Promise<T> => {
    const call = client[member];
    return (call ? call(...a) : fallback) as Promise<T> | T;
  };
  const current = (): unknown[] | null => (on() && args()) || null;
  // Solid's refetch reuses the source's last value; a refetch passes fresh arguments (a `Date.now()` window) as `refetching`.
  const [resource, { mutate, refetch }] = createResource<T, unknown[], unknown[]>(
    current,
    (a, { refetching }) => pluginData(() => read(Array.isArray(refetching) ? refetching : a), fallback),
    { initialValue: fallback, ...options },
  );
  const value = (): T => {
    if (!on()) return fallback;
    const v = settled(resource);
    return v === undefined ? fallback : v;
  };
  return Object.defineProperties(value, {
    loading: { get: () => resource.loading },
    failure: { get: () => failure(resource) },
    refetch: {
      value: async (): Promise<void> => {
        const fresh = untrack(current);
        if (fresh) await refetch(fresh);
      },
    },
    mutate: { value: (v: T): void => void mutate(() => v) },
  }) as PluginResource<T>;
}
