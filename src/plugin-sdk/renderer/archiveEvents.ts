import { createComputed, untrack } from 'solid-js';
import { onAppEvent, ARCHIVE_REFRESH_DEBOUNCE_MS } from './appEvents';
import { containedRoot, onCleanup, ownedOrContained, reportFailure } from './containment';
import { archiveGuild } from './archiveScope';
import { createArchiveGate } from './archiveGate';
import type { ArchiveChangeSet, ArchiveDeps } from './archiveChangeSet';

export type { ArchiveChangeSet, ArchiveDeps } from './archiveChangeSet';
export type { ArchiveChange, ArchiveChangeKind } from '@shared/contract';

/** Subscribes to matching changes with visibility gating, cancellation and one merged rerun. Returns an idempotent disposer. */
export function onArchiveChange(deps: ArchiveDeps, fn: (change: ArchiveChangeSet, signal: AbortSignal) => unknown): () => void {
  return ownedOrContained(() => {
    const dispose = containedRoot((end) => {
      const gate = createArchiveGate(deps, (change, signal) => untrack(() => fn(change, signal)), archiveGuild, ARCHIVE_REFRESH_DEBOUNCE_MS, reportFailure);
      const off = onAppEvent('archive-changed', (change) => untrack(() => gate.accept(change)));
      createComputed(() => { deps.shown?.(); untrack(() => gate.visibilityChanged()); });
      onCleanup(() => { off(); gate.dispose(); });
      return end;
    });
    onCleanup(dispose);
    return dispose;
  });
}
