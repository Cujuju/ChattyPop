// A resource whose value belongs to its source. Solid keeps a resource's last value while the next source loads and
// after the source turns off, so a bare resource shows one target's answer under another.
import { batchWrites, createStore, onCleanup, ownedOrContained } from '@plugin-sdk/renderer/containment';
import { failure, settled } from '@plugin-sdk/renderer/settled';
import { createMemo, createResource, createSignal, type Setter } from 'solid-js';
import { reconcile, unwrap } from 'solid-js/store';

/** An answer with the source it answers. */
interface Answer<S, T> {
  s: S;
  epoch: number;
  v: T;
}

export interface KeyedResource<T> {
  /** The answer for the current source; undefined while it loads, after it failed, and with no source. Never throws. Reactive. */
  (): T | undefined;
  /** A read for the current source is in flight. Reactive. */
  readonly loading: boolean;
  /** Why the current source's read failed; null while it didn't. Reactive. */
  readonly failure: string | null;
  /** Reads again after any current read, keeping its answer visible; concurrent refreshes share one pending reread. Resolves after that reread settles. */
  refetch(): Promise<void>;
  /** Hides cached answers and supersedes in-flight reads immediately. Resolves when the replacement settles. */
  invalidate(): Promise<void>;
}

/** `fetch`'s answer for `source()`, compared with ===: a primitive key, or an object by identity. Falsy sources read nothing. */
export function keyedResource<S, T>(source: () => S | false | null | undefined, fetch: (s: S) => Promise<T>): KeyedResource<T> {
  return ownedOrContained(() => {
    let live = true;
    let generation = 0;
    const [epoch, setEpoch] = createSignal(0);
    onCleanup(() => { live = false; });
    let flight: { s: S; done: Promise<Answer<S, T>> } | undefined;
    let pending: { s: S; generation: number; done: Promise<void> } | undefined;
    const [r, { refetch, mutate }] = createResource(source, (s) => {
      generation++;
      const asked = epoch();
      const mine = { s, done: (async (): Promise<Answer<S, T>> => ({ s, epoch: asked, v: await fetch(s) }))() };
      flight = mine;
      const clear = (): void => { if (flight === mine) flight = undefined; };
      void mine.done.then(clear, clear);
      return mine.done;
    }, { storage: (initial) => {
      // Same-source snapshots reconcile nested ids; different sources replace the answer.
      const [store, setStore] = createStore<{ answer: Answer<S, T> | undefined }>({ answer: initial });
      const set = (next: Answer<S, T> | undefined | ((previous: Answer<S, T> | undefined) => Answer<S, T> | undefined)) => {
        const previous = unwrap(store.answer);
        const answer = typeof next === 'function' ? next(previous) : next;
        batchWrites(() => {
          if (previous?.s !== answer?.s || previous?.epoch !== answer?.epoch) setStore('answer', undefined);
          setStore('answer', reconcile(answer, { key: 'id' }));
        });
        return store.answer;
      };
      return [() => store.answer, set as Setter<Answer<S, T> | undefined>];
    } });
    const refresh = (): Promise<void> => {
      const s = source();
      if (!live || !s) return Promise.resolve();
      if (pending?.s === s && pending.generation === generation) return pending.done;
      if (flight?.s !== s) return Promise.resolve(refetch()).then(() => undefined, () => undefined);
      const mine = { s, generation, done: flight.done.catch(() => undefined).then(() => {
        if (pending === mine) pending = undefined;
        if (live && source() === s && generation === mine.generation) return refetch();
      }).then(() => undefined, () => undefined) };
      pending = mine;
      return mine.done;
    };
    const invalidate = (): Promise<void> => {
      if (!live) return Promise.resolve();
      return batchWrites(() => {
        setEpoch((previous) => previous + 1);
        mutate(undefined);
        // false bypasses Solid's same-microtask refetch guard, replacing even a read started immediately before invalidation.
        return Promise.resolve(refetch(false)).then(() => undefined, () => undefined);
      });
    };
    const value = createMemo((): T | undefined => {
      const s = source();
      const a = settled(r);
      // The raw source: the store wraps an object one, which would never equal the source it answers.
      return s && a && unwrap(a).s === s && a.epoch === epoch() ? a.v : undefined;
    });
    return Object.defineProperties(value, {
      loading: { get: () => r.loading },
      failure: { get: () => (source() ? failure(r) : null) },
      refetch: { value: refresh },
      invalidate: { value: invalidate },
    }) as KeyedResource<T>;
  });
}
