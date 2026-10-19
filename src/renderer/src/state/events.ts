// App events for host stores: the SDK's single hub (@plugin-sdk/renderer/appEvents), and values core pushes.
import { ownedOrContained } from '@plugin-sdk/renderer/containment';
import { createSignal } from 'solid-js';
import type { AppEvent } from '@shared/contract';
import { onAppEvent } from '@plugin-sdk/renderer/appEvents';

export { ARCHIVE_REFRESH_DEBOUNCE_MS, onAppEvent, onMessagePartsChanged, onPluginEvent } from '@plugin-sdk/renderer/appEvents';

type EventOf<T extends AppEvent['type']> = Extract<AppEvent, { type: T }>;

/** A value core loads once and then pushes on `type`; null while loading or when the load failed. A push outranks the load's later answer. */
export function createPushedValue<T, K extends AppEvent['type']>(
  load: () => Promise<T>,
  type: K,
  pick: (e: EventOf<K>) => T,
): { value: () => T | null } {
  return ownedOrContained(() => {
    const [value, setValue] = createSignal<T | null>(null);
    /** Set once core pushed a value: the load's answer is older than it. */
    let pushed = false;
    onAppEvent(type, (e) => {
      pushed = true;
      setValue(() => pick(e));
    });
    new Promise<T>((resolve) => resolve(load())).then(
      (loaded) => {
        if (!pushed) setValue(() => loaded);
      },
      () => undefined, // Stays null until a push.
    );
    return { value };
  });
}

export { onArchiveChange, type ArchiveDeps, type ArchiveChangeSet, type ArchiveChangeKind, type ArchiveChange } from '@plugin-sdk/renderer/archiveEvents';
