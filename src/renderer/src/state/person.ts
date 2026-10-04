// Person view: whose profile the Person window shows, that profile from core, and their Discord profile as
// seen in the server of the channel shown when it opened.
import { api } from '@/api';
import { createResource, createSignal } from 'solid-js';
import { DM_GUILD_ID } from '@shared/discord';
import { channelById } from './directory';
import { shownChannelId } from './archive';
import { cachedThenLive } from './cachedLive';
import { onAppEvent } from './events';

interface PersonTarget {
  userId: string;
  /** The server whose member profile (roles, join date) shows; null outside one. */
  guildId: string | null;
}

const [target, setTarget] = createSignal<PersonTarget | null>(null);
export const personId = (): string | null => target()?.userId ?? null;
export const personGuildId = (): string | null => target()?.guildId ?? null;

export const [person, { refetch: refetchPerson }] = createResource(personId, (id) => api.core.personProfile(id));

/** Their Discord profile: the cached copy at once, then Discord's answer; stale when Discord can't be reached. */
export const discordProfile = cachedThenLive(
  target,
  (t) => api.core.discordProfile(t.userId, t.guildId),
  (t) => api.discord.profile(t.userId, t.guildId),
);

const [friendsOpen, setFriendsOpen] = createSignal(false);
/** Mutual friends load when their tab first opens, as in Discord's profile. */
export const showMutualFriends = (): void => {
  setFriendsOpen(true);
};
export const mutualFriends = cachedThenLive(
  () => friendsOpen() && personId(),
  (id) => api.core.mutualFriends(id),
  (id) => api.discord.mutualFriends(id),
);

const guildOf = (channelId: string | null): string | null => {
  const guild = channelId ? (channelById(channelId)?.guildId ?? null) : null;
  return guild === DM_GUILD_ID ? null : guild;
};

/** Opens `userId`'s profile as seen in the server of `channelId` (default: the channel the Archive shows). */
export const openPerson = (userId: string, channelId: string | null = shownChannelId()): void => {
  const same = personId() === userId;
  setFriendsOpen(false);
  // A new target object refetches their Discord profile, also for the same person.
  setTarget({ userId, guildId: guildOf(channelId) });
  // Re-opening the same person refreshes the archive part too: it may have grown since.
  if (same) void refetchPerson();
};

export const closePerson = (): void => {
  setTarget(null);
};

// Privacy mode changed: hidden servers and channels leave or rejoin the profile.
onAppEvent('privacy-changed', () => {
  if (personId()) void refetchPerson();
});
