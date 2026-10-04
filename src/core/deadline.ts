// A named deadline for awaited work (docs/plugin-architecture.md §8): a stalled call or report must not hold a queue.

/**
 * A signal that aborts `ms` from now with a TimeoutError, as AbortSignal.timeout does, but on the global timer, which
 * tests' fake timers drive. Never holds the core process open.
 */
export function deadline(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException(`No answer within ${ms} ms.`, 'TimeoutError')), ms).unref();
  return controller.signal;
}
