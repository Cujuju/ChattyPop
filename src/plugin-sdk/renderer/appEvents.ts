// Plugin SDK, renderer: the window's one app-event subscription (docs/plugin-architecture.md §5). The SDK owns it, so
// plugins and host stores (state/events.ts re-exports it) share a single hub over the @/api leaf.
import { api } from '@/api';
import type { AppEvent } from '@shared/contract';

type EventOf<T extends AppEvent['type']> = Extract<AppEvent, { type: T }>;
type Listener<T extends AppEvent['type']> = (e: EventOf<T>) => void;
const listeners = new Map<AppEvent['type'], Set<(e: AppEvent) => void>>();

// One bridge subscription for the whole renderer; stores subscribe by event type.
api.onEvent((e) => listeners.get(e.type)?.forEach((l) => l(e)));

/** Calls `listener` with each app event of `type`; returns an unsubscribe function. */
export function onAppEvent<T extends AppEvent['type']>(type: T, listener: Listener<T>): () => void {
  const set = listeners.get(type) ?? new Set();
  set.add(listener as (e: AppEvent) => void);
  listeners.set(type, set);
  return () => set.delete(listener as (e: AppEvent) => void);
}

/** A bundled plugin's event for windows (its core side's channels.emit); the SDK's onEvent types it. */
export const onPluginEvent = (pluginId: string, name: string, listener: (payload: unknown) => void): (() => void) =>
  onAppEvent('plugin-event', (e) => {
    if (e.pluginId === pluginId && e.name === name) listener(e.payload);
  });

/** Backfill emits many archive changes; lists derived from the archive re-read at most this often. */
export const ARCHIVE_REFRESH_DEBOUNCE_MS = 2000;

/** Calls `fn` once a burst of `type` events has been quiet for `ms`. */
export function onAppEventDebounced<T extends AppEvent['type']>(type: T, ms: number, fn: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const off = onAppEvent(type, () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  });
  return () => {
    clearTimeout(timer);
    off();
  };
}

/** Subscribes to changed plugin message parts. ids targets rows; null covers plugin toggles. Snapshot views re-read affected messages; returns unsubscribe. */
export function onMessagePartsChanged(fn: (ids: string[] | null) => void): () => void {
  const offs = [
    onAppEvent('message-labels-changed', (e) => fn(e.messageIds)),
    onAppEvent('attachment-notes-changed', (e) => fn(e.messageIds)),
    onAppEvent('plugins-changed', () => fn(null)),
  ];
  return () => offs.forEach((off) => off());
}
