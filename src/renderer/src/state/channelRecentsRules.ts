// Recent channels and the switcher's order. Pure, so tests read it; state/channelRecents.ts keeps the list.
import { stringsOr } from '@shared/normalize';

/** Channels remembered: a working set to flip between. Older ones list by activity in the switcher. */
export const RECENT_CHANNELS_MAX = 10;

/** Stored recents: distinct ids, at most RECENT_CHANNELS_MAX. */
export const normalizeRecentChannels = (v: unknown): string[] => [...new Set(stringsOr([])(v))].slice(0, RECENT_CHANNELS_MAX);

/** `recents` with `id` moved to the front. */
export const withRecent = (recents: readonly string[], id: string): string[] => [id, ...recents.filter((r) => r !== id)].slice(0, RECENT_CHANNELS_MAX);

/** The most recent channel other than `current` that `showable` accepts, or null: the back shortcut's target. */
export const previousChannel = (recents: readonly string[], current: string | null, showable: (id: string) => boolean): string | null =>
  recents.find((id) => id !== current && showable(id)) ?? null;

/** What the switcher reads of a channel. */
export interface SwitcherChannel {
  id: string;
  name: string;
  guildName: string;
  lastTs: number | null;
}

/**
 * Channels whose name or server holds every word of `query`: recent ones first, most recent first, then the rest by
 * latest activity. The shown channel (`current`) counts as not recent, so the first row is the one to go back to.
 */
export function switcherOrder<T extends SwitcherChannel>(channels: readonly T[], recents: readonly string[], current: string | null, query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const rank = new Map(recents.filter((id) => id !== current).map((id, i) => [id, i]));
  // Every channel not recent shares the last rank, so activity orders them.
  const rankOf = (c: T): number => rank.get(c.id) ?? rank.size;
  return channels
    .filter((c) => words.every((w) => `${c.name} ${c.guildName}`.toLowerCase().includes(w)))
    .sort((a, b) => rankOf(a) - rankOf(b) || (b.lastTs ?? 0) - (a.lastTs ?? 0));
}
