// Who is typing in the Archive's open channel, from main's 'typing' events: each typist lasts TYPING_TTL_MS past their
// last event, and their message arriving ends them, as Discord's client does.
import { api } from '@/api';
import { createEffect, createMemo, createRoot, on } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { compareSnowflakes } from '@shared/discord';
import { TYPING_TTL_MS, type Typist } from '@shared/typing';
import { archiveChannelId, archiveState } from './archive';
import { onAppEvent } from './events';
import { isSelf } from './ownMessages';

/** Tracks current-channel typists in insertion order. Drops other-channel events; names remain empty until core resolution. */
const [typists, setTypists] = createStore<Record<string, Typist>>({});
/** Names core gave for ids whose events carry none. */
const [names, setNames] = createStore<Record<string, string>>({});
const timers = new Map<string, ReturnType<typeof setTimeout>>();

const drop = (userId: string): void => {
  clearTimeout(timers.get(userId));
  timers.delete(userId);
  setTypists(produce((t) => void delete t[userId]));
};
const dropAll = (): void => Object.keys(typists).forEach(drop);

onAppEvent('typing', (e) => {
  if (e.channelId !== archiveChannelId() || isSelf(e.userId)) return;
  clearTimeout(timers.get(e.userId));
  timers.set(e.userId, setTimeout(() => drop(e.userId), TYPING_TTL_MS));
  const name = e.name ?? names[e.userId] ?? '';
  // Update typists in place to preserve insertion order.
  setTypists(
    produce((t) => {
      const typist = (t[e.userId] ??= { name });
      typist.name = name;
      if (e.verb) typist.verb = e.verb;
      else delete typist.verb;
    }),
  );
  if (!name) void nameOf(e.userId);
});

/** Fills unnamed active typists from core display names without overwriting newer event nicknames. Unknown archive users remain unlisted. */
async function nameOf(userId: string): Promise<void> {
  const [person] = await api.core.peopleByIds([userId]).catch(() => []);
  if (!person) return;
  setNames(userId, person.name);
  if (typists[userId] && !typists[userId].name) setTypists(userId, 'name', person.name);
}

// Privacy mode changed: whatever showed may now be hidden (the Archive reopens or closes its channel on its own).
onAppEvent('privacy-changed', dropAll);

createRoot(() => {
  // Another channel opened: its typists are its own.
  createEffect(on(archiveChannelId, dropAll, { defer: true }));
  // A typist's message arrived: they are done. Every message newer than the last seen counts (a refresh brings several).
  let newestSeen: string | null = null;
  createEffect(
    on(
      () => archiveState.items,
      (items) => {
        const before = newestSeen;
        newestSeen = items.at(-1)?.id ?? null;
        for (let i = items.length - 1; i >= 0; i--) {
          const m = items[i]!;
          if (before !== null && compareSnowflakes(m.id, before) <= 0) break;
          if (typists[m.author.id]) drop(m.author.id);
        }
      },
    ),
  );
});

/** Who is typing in the open channel, in the order they began; those core hasn't named yet, and the owner (whose id
 * may arrive after their event), are left out. */
export const typing = createMemo<Typist[]>(() => Object.entries(typists).flatMap(([id, t]) => (t.name && !isSelf(id) ? [t] : [])));
