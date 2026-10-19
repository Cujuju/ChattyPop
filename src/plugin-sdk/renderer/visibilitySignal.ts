import { createComputed, createSignal, untrack, type Accessor } from 'solid-js';
import { onCleanup, ownedOrContained } from './containment';
import { pageShown } from './panelShown';

/** Each visible lifetime owns one cancellation signal; hiding or disposal aborts it, and showing creates a fresh one. */
export function visibilitySignal(shown: Accessor<boolean> = pageShown): Accessor<AbortSignal> {
  return ownedOrContained(() => {
    let controller = new AbortController();
    const [signal, setSignal] = createSignal(controller.signal);
    createComputed(() => {
      const visible = shown();
      untrack(() => {
        if (!visible) controller.abort();
        else if (controller.signal.aborted) {
          controller = new AbortController();
          setSignal(controller.signal);
        }
      });
    });
    onCleanup(() => controller.abort());
    return signal;
  });
}
