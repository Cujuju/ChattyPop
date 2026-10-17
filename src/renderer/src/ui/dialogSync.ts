// A non-modal <dialog> shown while its owner's state says open. Its native close event comes queued after every close,
// including the ones this sync makes, so the event alone doesn't say the owner asked to close.
import { createEffect, on } from 'solid-js';

/** The parts of a <dialog> the sync uses. */
export interface DialogElement {
  readonly open: boolean;
  show(): void;
  close(): void;
}

export interface DialogSyncHooks {
  /** Just shown. */
  shown(): void;
  /** About to close (its geometry is still measurable). */
  hiding(): void;
  /** Closed. */
  hidden(): void;
  /** Something other than `open` closed it (a form's method="dialog"): the owner's close, as a close button asks. */
  request(): void;
}

/**
 * Shows the dialog while `open()` and closes it when not. Returns the native close event's handler: an event queued
 * before a reopen is stale, and one from `open()` turning false is no request, so neither reaches the owner.
 */
export function syncDialog(el: () => DialogElement, open: () => boolean, hooks: DialogSyncHooks): () => void {
  createEffect(
    on(open, (want) => {
      const d = el();
      if (want && !d.open) {
        d.show();
        hooks.shown();
      } else if (!want && d.open) {
        hooks.hiding();
        d.close();
        hooks.hidden();
      }
    }),
  );
  return () => {
    if (el().open || !open()) return;
    hooks.hidden();
    hooks.request();
  };
}
