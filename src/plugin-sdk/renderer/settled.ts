// Reading a Solid resource whose last fetch failed throws, and no error boundary catches it: these read it safely.
import type { Resource } from 'solid-js';
import { errorMessage } from '@shared/errors';

/** `r`'s value; undefined while its last fetch failed (a refetch in flight reads the value before). Never throws. Reactive. */
export const settled = <T>(r: Resource<T>): T | undefined => (r.state === 'errored' ? undefined : r());

/** Why `r`'s last fetch failed; null while it didn't. Reactive. */
export const failure = (r: Resource<unknown>): string | null => (r.state === 'errored' ? errorMessage(r.error) : null);
