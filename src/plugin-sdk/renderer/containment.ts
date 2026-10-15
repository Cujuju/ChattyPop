// An ownerless event-handler or async-continuation call creates a root that lives as long as the window.
import { batch, catchError, createRoot, getOwner, onCleanup as solidOnCleanup, untrack } from 'solid-js';
import { createStore as solidCreateStore, type SetStoreFunction } from 'solid-js/store';
import * as solid from 'solid-js';
import * as solidStore from 'solid-js/store';

/** Installed plugins share the host's Solid instances. */
export const solidHostModules = { 'solid-js': solid, 'solid-js/store': solidStore };

/** Reports to the page's error handlers without throwing or tracking. */
export function reportFailure(error: unknown): void {
  untrack(() => {
    try {
      (globalThis as typeof globalThis & { reportError(error: unknown): void }).reportError(error);
    } catch {
      // A handler must not throw into Solid's error dispatch.
    }
  });
}

/** Disposes and raises setup failures; reports later failures. First-run computations inside an active update report after setup returns. */
export function containedRoot<T>(make: () => T): T {
  let live = false;
  let setup: { error: unknown } | undefined;
  let lastReported: string | undefined;
  let dispose!: () => void;
  const value = createRoot((d) => {
    dispose = d;
    return catchError(
      () => {
        try {
          return make();
        } catch (error) {
          setup ??= { error };
          return undefined;
        }
      },
      (error) => {
        if (!live) {
          setup ??= { error };
          return;
        }
        untrack(() => {
          try {
            const key = `${String(error)}\n${error instanceof Error ? error.stack : ''}`;
            if (key === lastReported) return;
            lastReported = key;
            reportFailure(error);
          } catch {
            reportFailure(error);
          }
        });
      },
    );
  });
  live = true;
  if (setup) {
    try {
      dispose();
    } finally {
      throw setup.error;
    }
  }
  return value as T;
}

/** Uses the current, already contained owner; creates a contained root when there is none. */
export const ownedOrContained = <T>(make: () => T): T => (getOwner() ? make() : containedRoot(make));

/** Flushes writes before raising a callback's failure, at the outermost transaction or nested in batchWrites or a contained computation. */
export function batchWrites<T>(write: () => T): T {
  const outcome = batch((): { value: T } | { error: unknown } => {
    try {
      return { value: write() };
    } catch (error) {
      return { error };
    }
  });
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}

/** Registers with the current owner; a failure is reported without interrupting the remaining cleanups. */
export function onCleanup<T extends () => unknown>(fn: T): T {
  solidOnCleanup(() => {
    try {
      fn();
    } catch (error) {
      reportFailure(error);
    }
  });
  return fn;
}

/** Flushes an updater's earlier writes before raising its failure. */
export function createStore<T extends object = {}>(...args: Parameters<typeof solidCreateStore<T>>): ReturnType<typeof solidCreateStore<T>> {
  const [store, set] = solidCreateStore<T>(...args);
  const write = set as (...args: unknown[]) => void;
  const guarded = ((...args: unknown[]) => batchWrites(() => write(...args))) as SetStoreFunction<T>;
  return [store, guarded];
}
