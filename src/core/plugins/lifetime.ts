// A plugin lifetime (docs/plugin-architecture.md §8): a core activation or a main resource run. Its abort signal, the
// fence for work that outlives it, and the effects scoped to it.
import { PluginInactiveError } from '@shared/pluginCall';
import { joined, untilRevoked } from '../ai/revocable';
import type { PluginFetch } from './net';

/** One lifetime of a plugin: a core activation (activate until turned off), or one run of a main resource. */
export interface Lifetime {
  /** Aborted with PluginInactiveError when this lifetime ends; pass it to anything cancellable. */
  readonly signal: AbortSignal;
  /** Whether this lifetime still runs: false once it ended, even after the plugin is turned on again. */
  live(): boolean;
  /**
   * `work`'s result while this lifetime runs; rejects with PluginInactiveError once it ended, so code after the await
   * never writes, emits or schedules for a retired lifetime.
   */
  fence<T>(work: Promise<T>): Promise<T>;
}

/** A new lifetime of plugin `pluginId`; `end` retires it. */
export function pluginLifetime(pluginId: string): Lifetime & { end(): void } {
  const controller = new AbortController();
  const { signal } = controller;
  return {
    signal,
    live: () => !signal.aborted,
    fence: (work) => {
      void work.catch(() => undefined); // fenced after it ended: its later failure is nobody's to handle
      return untilRevoked(signal, () => work);
    },
    end: () => controller.abort(new PluginInactiveError(pluginId)),
  };
}

/**
 * `fetch` scoped to `lifetime`: a request joins its signal, none is sent once it ended, and one still running then
 * settles with PluginInactiveError at once, even where the server or a redirect ignores the abort.
 */
export const lifetimeFetch =
  (fetch: PluginFetch, lifetime: Pick<Lifetime, 'signal'>): PluginFetch =>
  (url, init = {}) =>
    untilRevoked(lifetime.signal, () => fetch(url, { ...init, signal: joined(lifetime.signal, init.signal ?? undefined) }));
