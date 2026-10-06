// Batches name reads per place/person. Name events refresh cached values; privacy changes clear them.
import { createStore, reconcile } from 'solid-js/store';
import type { PersonName } from '@shared/contract';
import { api } from '@/api';
import { onAppEvent } from './events';

/** No place: the name with no server context. */
const NO_PLACE = '';
const keyOf = (userId: string, channelId: string | null): string => `${channelId ?? NO_PLACE}:${userId}`;

/** Per person and place: their name, null when core doesn't know them; absent until asked. */
const [names, setNames] = createStore<Record<string, PersonName | null>>({});
/** Asked for and not yet answered, per place. */
const queued = new Map<string, Set<string>>();
/** Bumped by a privacy change: an answer asked for before it is dropped. */
let generation = 0;

function ask(channelId: string | null, userIds: Iterable<string>): void {
  const place = channelId ?? NO_PLACE;
  const wasEmpty = queued.size === 0;
  const ids = queued.get(place) ?? new Set<string>();
  for (const id of userIds) ids.add(id);
  queued.set(place, ids);
  if (wasEmpty) queueMicrotask(flush);
}

function flush(): void {
  const asked = generation;
  for (const [place, ids] of queued) {
    const channelId = place === NO_PLACE ? null : place;
    void api.core.personNames([...ids], channelId).then((found) => {
      if (asked !== generation) return;
      const byId = new Map(found.map((n) => [n.id, n]));
      setNames(Object.fromEntries([...ids].map((id) => [keyOf(id, channelId), byId.get(id) ?? null])));
    });
  }
  queued.clear();
}

/** Every person and place read so far, asked for again. */
function askAgain(): void {
  const byPlace = new Map<string | null, string[]>();
  for (const key of Object.keys(names)) {
    const at = key.lastIndexOf(':');
    const place = key.slice(0, at) || null;
    byPlace.set(place, [...(byPlace.get(place) ?? []), key.slice(at + 1)]);
  }
  byPlace.forEach((ids, channelId) => ask(channelId, ids));
}

onAppEvent('archive-changed', (e) => {
  if (e.namesChanged) askAgain();
});
// Cleared at once: names still shown read again (personName asks for what it lacks).
onAppEvent('privacy-changed', () => {
  generation++;
  setNames(reconcile({}));
});

/**
 * How `userId`'s name shows in `channelId` (null: no place); undefined while it loads, null when core doesn't know them.
 * Reactive: follows renames, role and style changes, and privacy mode.
 */
export function personName(userId: string, channelId: string | null): PersonName | null | undefined {
  const key = keyOf(userId, channelId);
  const name = names[key];
  if (name === undefined && !queued.get(channelId ?? NO_PLACE)?.has(userId)) ask(channelId, [userId]);
  return name;
}
