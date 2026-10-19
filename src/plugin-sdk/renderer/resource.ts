// Plugin SDK, renderer: a plugin core call as a Solid resource (docs/plugin-architecture.md §5), settled against the
// window's audience, the plugin's switch and the deactivation race.
import { onCleanup, ownedOrContained } from './containment';
import { onArchiveChange, type ArchiveDeps } from './archiveEvents';
import { createComputed, createSignal, untrack, type Accessor, type Setter, type ResourceOptions } from 'solid-js';
import type { ChannelsOf, PluginDescriptor } from '@shared/bundledTypes';
import type { MembersFor } from '@shared/pluginChannels';
import { coreClient, type WindowAudience, type WindowMember } from './clients';
import { callable } from './pluginList';
import { pluginData } from './data';


type Shapes<D> = MembersFor<ChannelsOf<D>, 'core', WindowAudience>;
type ArgsOf<D, K extends WindowMember<D>> = Shapes<D>[K] extends (...args: infer A) => unknown ? A : never;
type ResultOf<D, K extends WindowMember<D>> = Shapes<D>[K] extends (...args: never[]) => infer R ? Awaited<R> : never;

/** A core call's latest result, read like a signal. */
export interface PluginResource<T> {
  /** The result; the fallback before the first, while this window may not call the member or `args` gives none, and after a failed read. Never throws. Reactive. */
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

/** Reads callable core resources with current args and refreshes on changes. Inactive/late answers use fallback; other failures retain messages. */
export function pluginResource<const D extends PluginDescriptor, K extends WindowMember<D>, F>(
  plugin: D,
  member: K,
  // A spread tuple, so an array literal `args` returns is read as the member's argument tuple.
  args: () => [...ArgsOf<D, K>] | null | undefined | false,
  fallback: F,
  options: Pick<ResourceOptions<ResultOf<D, K> | F>, 'storage'> & { refreshOn?: ArchiveDeps; shown?: Accessor<boolean> } = {},
): PluginResource<ResultOf<D, K> | F> {
  return ownedOrContained(() => {
    type T = ResultOf<D, K> | F;
    const on = (): boolean => callable(plugin, member);
    const shown = options.shown ?? options.refreshOn?.shown ?? (() => true);
    const [value, setValue] = (options.storage ? options.storage(fallback) : createSignal<T>(fallback)) as [Accessor<T | undefined>, Setter<T | undefined>];
    const [loading, setLoading] = createSignal(false);
    const [error, setError] = createSignal<string | null>(null);
    const [enabled, setEnabled] = createSignal(false);
    let pending = false;
    let disposed = false;
    let flight: Promise<void> | undefined;
    let controller: AbortController | undefined;
    let source: unknown[] | null = null;
    let queued: Promise<void> | undefined;
    const pump = async (): Promise<void> => {
      if (flight) { await flight; return pump(); }
      if (!pending || disposed || !untrack(shown) || !source) return;
      pending = false;
      const mine = new AbortController();
      controller = mine;
      const fresh = untrack(args);
      if (!fresh || !untrack(on)) return;
      setLoading(true);
      flight = (async () => {
        try {
          const result = await pluginData(() => {
            const client = coreClient(plugin, { signal: mine.signal, priority: untrack(shown) ? 'interactive' : 'background' }) as Record<string, (...args: unknown[]) => Promise<T>>;
            return client[member]!(...fresh);
          }, fallback);
          if (!mine.signal.aborted && !disposed) { setValue(() => result); setError(null); }
        } catch (e) {
          if (!mine.signal.aborted && !disposed) { setValue(() => fallback); setError(String(e instanceof Error ? e.message : e)); }
        } finally { flight = undefined; controller = undefined; setLoading(false); }
      })();
      await flight;
      if (pending) await pump();
    };
    const request = (): Promise<void> => {
      pending = true;
      if (source && untrack(shown)) setLoading(true);
      controller?.abort();
      // Source changes and a stale-on-show notification in the same turn share one read.
      if (!queued) queued = Promise.resolve().then(async () => { queued = undefined; await pump(); });
      return queued;
    };
    createComputed(() => {
      source = (on() && args()) || null;
      const visible = shown();
      setEnabled(!!source);
      untrack(() => {
        controller?.abort();
        if (!source) { pending = false; setValue(() => fallback); setError(null); }
        else { pending = true; if (visible) void request(); }
      });
    });
    if (options.refreshOn) onArchiveChange({ ...options.refreshOn, shown }, (_change, signal) => {
      if (signal.aborted) return;
      const abort = () => controller?.abort();
      signal.addEventListener('abort', abort, { once: true });
      return request().finally(() => signal.removeEventListener('abort', abort));
    });
    onCleanup(() => { disposed = true; controller?.abort(); });
    const result = (): T => enabled() ? value() as T : fallback;
    return Object.defineProperties(result, {
      loading: { get: loading },
      failure: { get: error },
      refetch: { value: request },
      mutate: { value: (v: T): void => { setValue(() => v); } },
    }) as PluginResource<T>;
  });
}
