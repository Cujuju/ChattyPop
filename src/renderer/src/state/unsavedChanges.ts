// This window's unsaved edits (a rule's editor). Main holds the window's close or reload while it reports some and
// asks here (main/unsavedChanges), so the question is the app's own dialog.
import { createEffect, onCleanup, type Accessor } from 'solid-js';
import { api } from '@/api';
import { listen } from '@/ui/listen';
import { onAppEvent } from './events';

interface Guard {
  dirty: Accessor<boolean>;
  /** Asks the owner whether to discard the edits; true to discard. */
  ask: () => Promise<boolean>;
}

let guard: Guard | null = null;
/** The owner discarded for a close or reload under way: the page may unload. */
let discarded = false;

const unsaved = (): boolean => !discarded && (guard?.dirty() ?? false);

/** Guards the calling component's edits while it lives; `ask` is the question main's hold puts to the owner. */
export function guardUnsaved(dirty: Accessor<boolean>, ask: () => Promise<boolean>): void {
  const own: Guard = { dirty, ask };
  guard = own;
  createEffect(() => api.setUnsaved(unsaved()));
  // Backstop for an unload main didn't hold (a reload): refusing it makes main ask.
  listen(window, 'beforeunload', (e) => {
    if (unsaved()) e.preventDefault();
  });
  onCleanup(() => {
    if (guard !== own) return;
    guard = null;
    api.setUnsaved(false);
  });
}

onAppEvent('unsaved-changes', () => {
  // No guard left (the editor closed meanwhile): nothing to lose, so the close or reload goes on.
  void (guard?.ask() ?? Promise.resolve(true)).then((discard) => {
    if (!discard) return; // kept: what main held never runs
    discarded = true;
    api.discardUnsaved();
  });
});
