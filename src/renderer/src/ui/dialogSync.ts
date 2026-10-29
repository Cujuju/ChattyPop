// A <dialog> shown exactly while its owner's state says open. Its native close event follows every close, ours included, so
// alone it isn't the owner's request.
import { createEffect, on } from 'solid-js';

/** The parts of a <dialog> the sync uses. */
export interface DialogElement {
  readonly open: boolean;
  show(): void;
  showModal(): void;
  close(): void;
}

export interface DialogSyncHooks {
  /** Just shown. */
  shown?(): void;
  /** About to close (its geometry is still measurable). */
  hiding?(): void;
  /** Closed. */
  hidden?(): void;
  /** Something other than `open` closed it (Escape, a form's method="dialog"); shown again, the owner decides, as for a close button. */
  request(): void;
}

/**
 * Shows the dialog (in `mode`) exactly while `open()`. The returned close handler ignores stale events and closes
 * made by `open()`; any other close re-shows it, then asks the owner (request).
 */
export function syncDialog(el: () => DialogElement, open: () => boolean, hooks: DialogSyncHooks, mode: 'modeless' | 'modal' = 'modeless'): () => void {
  const show = (d: DialogElement): void => (mode === 'modal' ? d.showModal() : d.show());
  createEffect(
    on(open, (want) => {
      const d = el();
      if (want && !d.open) {
        show(d);
        hooks.shown?.();
      } else if (!want && d.open) {
        hooks.hiding?.();
        d.close();
        hooks.hidden?.();
      }
    }),
  );
  return () => {
    const d = el();
    if (d.open || !open()) return;
    show(d);
    hooks.request();
  };
}
