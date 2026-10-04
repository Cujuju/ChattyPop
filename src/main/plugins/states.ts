// Which bundled plugins are on, as main sees them: core's plugin list, re-read on each plugins-changed event.
import { pluginOn, type PluginInfo } from '@shared/plugins';
import { pluginLifetime, type Lifetime } from '@core/plugins/lifetime';
import { labelRefresher } from './labelAvailability';

/** Main's copy of core's on/off states; listeners run after each fresh snapshot. */
export class PluginStates {
  private on = new Set<string>();
  private readonly listeners = new Set<() => void>();
  /** Re-reads core's list; only the newest request may publish. Resolves once the snapshots requested so far are in. */
  readonly refresh: () => Promise<void>;

  constructor(private readonly load: () => Promise<readonly PluginInfo[]>, failed: (error: unknown) => void) {
    this.refresh = labelRefresher(load, (list) => {
      this.on = new Set(list.filter((p) => p.bundled && p.status === 'active').map((p) => p.id));
      for (const fn of this.listeners) fn();
    }, failed);
  }

  /** Whether bundled plugin `id` is on, as of the latest snapshot. */
  active(id: string): boolean {
    return this.on.has(id);
  }

  /** Whether bundled plugin `id` is on now, read from core: for a check just before an effect, not the snapshot's lag. */
  async confirmed(id: string): Promise<boolean> {
    return pluginOn(await this.load(), id);
  }

  /** Runs `fn` after every snapshot; returns an unsubscribe function. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** Why a switch-governed resource stops: its plugin turned off, or the app is quitting (external config may stay). */
export type StopReason = 'off' | 'quit';
/** A resource's disposer. */
export type Dispose = (reason: StopReason) => void | Promise<void>;
/** Starts one run of a resource while its plugin is on, given the run's lifetime; returns what stops it. */
export type RunStart = (run: Lifetime) => void | Dispose | Promise<void | Dispose>;

/**
 * Keeps `start`'s resource running exactly while `active()` is true, each run with a fresh lifetime of plugin
 * `pluginId`: it ends before the run's disposer runs (or when its start fails), so the run's late effects refuse. A run
 * still starting when the plugin turns off (or the app quits) ends at once; once its start returns, it is disposed.
 * Transitions are serialized, so a quick off/on never leaves two running; `stop()` ends it for good (app quit). A throw
 * from start or its disposer goes to `failed`.
 */
export function whileActive(pluginId: string, active: () => boolean, start: RunStart, failed: (error: unknown) => void): { sync(): Promise<void>; stop(): Promise<void> } {
  let run: ReturnType<typeof pluginLifetime> | null = null;
  let dispose: Dispose | null = null;
  /** The run whose start is awaited, not yet `run`. */
  let starting: ReturnType<typeof pluginLifetime> | null = null;
  let quitting = false;
  const wanted = (): boolean => active() && !quitting;
  let chain = Promise.resolve();
  const step = (): Promise<void> =>
    (chain = chain.then(async () => {
      const want = wanted();
      if (want === (run !== null)) return;
      if (want) {
        // Running only once started: a failed start is tried again at the next change.
        const next = (starting = pluginLifetime(pluginId));
        let started: Dispose | null;
        try {
          started = (await start(next)) ?? null;
        } catch (err) {
          next.end();
          throw err;
        } finally {
          starting = null;
        }
        // Turned off (or quitting) while it started: its lifetime already ended; a later step starts afresh if wanted.
        if (!next.live()) return void (await started?.(quitting ? 'quit' : 'off'));
        run = next;
        dispose = started;
      } else {
        run!.end();
        run = null;
        const d = dispose;
        dispose = null;
        await d?.(quitting ? 'quit' : 'off');
      }
    }).catch(failed));
  /** Ends a starting run at once when it is no longer wanted: its start's late effects refuse from now on. */
  const revokeStarting = (): void => {
    if (starting && !wanted()) starting.end();
  };
  return {
    sync: () => {
      revokeStarting();
      return step();
    },
    stop: () => {
      quitting = true;
      revokeStarting();
      return step();
    },
  };
}
