// Call scheduling scope, apart from the window transport so lists and gates can set it without importing it.
import type { ReadPriority } from '@shared/readPriority';

/** Bind gate signals explicitly for calls made after an await; resources bind their own signal. */
export interface CallOptions { signal?: AbortSignal; priority?: ReadPriority }
let current: CallOptions | undefined;

/** Captures calls issued synchronously by an archive gate, without retaining mutable state across awaits. */
export function withCallOptions<T>(options: CallOptions, run: () => T): T {
  const previous = current;
  current = options;
  try { return run(); } finally { current = previous; }
}

/** The options of the innermost `withCallOptions` running now. */
export const currentCallOptions = (): CallOptions | undefined => current;
