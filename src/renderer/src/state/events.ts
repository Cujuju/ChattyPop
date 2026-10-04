// App events for host stores: the SDK's single hub (@plugin-sdk/renderer/appEvents), and values core pushes.
import { createResource } from 'solid-js';
import type { AppEvent } from '@shared/contract';
import { onAppEvent } from '@plugin-sdk/renderer/appEvents';

export { ARCHIVE_REFRESH_DEBOUNCE_MS, onAppEvent, onAppEventDebounced, onMessagePartsChanged, onPluginEvent } from '@plugin-sdk/renderer/appEvents';

type EventOf<T extends AppEvent['type']> = Extract<AppEvent, { type: T }>;

/** A value core loads once and then pushes on `type`; null while loading or when the load failed. */
export function createPushedValue<T, K extends AppEvent['type']>(
  load: () => Promise<T>,
  type: K,
  pick: (e: EventOf<K>) => T,
): { value: () => T | null; refetch: () => unknown } {
  const [value, { mutate, refetch }] = createResource<T | null>(() => load().catch(() => null));
  onAppEvent(type, (e) => mutate(() => pick(e)));
  return { value: () => value() ?? null, refetch };
}
