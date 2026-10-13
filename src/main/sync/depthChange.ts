// A deeper history setting takes effect when it is made: the channels it deepens are queued, not left for the next start.
import { SETTINGS_KEYS, normalizeArchiveSettings, resolveBackfillCutoffMs, type ArchiveSettings } from '@shared/settings';
import { errorMessage } from '@shared/errors';
import { MS_PER_S } from '@shared/units';
import type { CoreClient } from '../coreClient';
import { diag } from '../diagnostics';
import { readArchiveSettings } from './pace';
import type { SyncService } from './syncService';

/** An amount is stepped or retyped in several changes; a pause this long means the value is meant. */
const DEPTH_CHANGE_SETTLE_MS = 2 * MS_PER_S;

/** Those of `channelIds` (no threads: they follow their channel) whose history reaches further back under `next` than under `prev`. */
export const deepenedChannels = (prev: ArchiveSettings, next: ArchiveSettings, channelIds: readonly string[], now: number): string[] =>
  channelIds.filter((id) => resolveBackfillCutoffMs(next, id, now) < resolveBackfillCutoffMs(prev, id, now));

/** Queues the archived channels a settings change deepens, once the change has settled. */
export function followDepthChanges(core: CoreClient, sync: Pick<SyncService, 'enqueue'>): void {
  /** The settings sync last acted on. Unread at start (the failure is logged), the first change sets it and queues nothing. */
  let applied: ArchiveSettings | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  void readArchiveSettings(core).then(
    (s) => (applied ??= s),
    (err: unknown) => diag('depth-change-baseline-unread', { message: errorMessage(err) }),
  );
  core.on('event', (e) => {
    if (e.type !== 'setting-changed' || e.key !== SETTINGS_KEYS.archive) return;
    const next = normalizeArchiveSettings(e.value);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const prev = applied;
      applied = next;
      if (!prev) return;
      void core.call('optedInChannels').then(
        (ids) => deepenedChannels(prev, next, ids, Date.now()).forEach((id) => sync.enqueue(id)),
        (err: unknown) => diag('depth-change-queue-failed', { message: errorMessage(err) }),
      );
    }, DEPTH_CHANGE_SETTLE_MS);
  });
}
