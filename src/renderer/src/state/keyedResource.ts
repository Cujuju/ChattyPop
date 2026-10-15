// A resource whose value belongs to its source. Solid keeps a resource's last value while the next source loads and
// after the source turns off, so a bare resource shows one target's answer under another.
import { ownedOrContained } from '@plugin-sdk/renderer/containment';
import { failure, settled } from '@plugin-sdk/renderer/settled';
import { createResource } from 'solid-js';

/** An answer with the source it answers. */
interface Answer<S, T> {
  s: S;
  v: T;
}

export interface KeyedResource<T> {
  /** The answer for the current source; undefined while it loads, after it failed, and with no source. Never throws. Reactive. */
  (): T | undefined;
  /** A read for the current source is in flight. Reactive. */
  readonly loading: boolean;
  /** Why the current source's read failed; null while it didn't. Reactive. */
  readonly failure: string | null;
  /** Reads the current source again; its answer stays shown until the new one lands. */
  refetch(): void;
}

/** `fetch`'s answer for `source()`, compared with ===, so a source is a primitive key. Falsy sources read nothing. */
export function keyedResource<S, T>(source: () => S | false | null | undefined, fetch: (s: S) => Promise<T>): KeyedResource<T> {
  return ownedOrContained(() => {
    const [r, { refetch }] = createResource(source, async (s): Promise<Answer<S, T>> => ({ s, v: await fetch(s) }));
    const value = (): T | undefined => {
      const s = source();
      const a = settled(r);
      return s && a?.s === s ? a.v : undefined;
    };
    return Object.defineProperties(value, {
      loading: { get: () => r.loading },
      failure: { get: () => (source() ? failure(r) : null) },
      refetch: { value: (): void => void refetch() },
    }) as KeyedResource<T>;
  });
}
