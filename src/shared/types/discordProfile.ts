// Caches embedded-session profile/reaction data beyond the archive for immediate/offline display.
import type { RawUser } from '../discord';
import type { PersonMatch } from './people';

/** A person as Discord's profile window shows them; the member fields describe one server (`guildId`). */
export interface DiscordProfile {
  userId: string;
  /** The server the member fields (roles, join date) describe; null outside one. */
  guildId: string | null;
  /** Banner image hash; null for none (accentColor fills the banner instead). */
  banner: string | null;
  /** 0xRRGGBB behind the banner; null for Discord's default. */
  accentColor: number | null;
  /** Discord markdown; their server profile's when they set one. Empty for none. */
  bio: string;
  pronouns: string;
  badges: { id: string; description: string; icon: string; link: string | null }[];
  /** When they joined the server (ms); null outside one. */
  joinedAt: number | null;
  /** Their roles in the server, highest first. */
  roles: { id: string; name: string; color: number | null }[];
  /** The owner's private note about them; null for none. */
  note: string | null;
  /** Since when they are the owner's friend (ms); null when not friends. */
  friendsSince: number | null;
  /** Servers the owner shares with them (privacy mode's hidden ones left out). */
  mutualGuilds: { id: string; name: string | null; icon: string | null; nick: string | null }[];
  mutualFriendsCount: number;
  /** Their connected accounts, as Discord lists them (`type`: Discord's platform id, e.g. "steam"). */
  connections: { type: string; name: string; verified: boolean }[];
  /** When Discord answered (ms): an old one is shown "as of" this while a refresh can't reach Discord. */
  fetchedAt: number;
}

/** Friends the owner shares with someone, as Discord's profile lists them. */
export interface MutualFriends {
  people: PersonMatch[];
  fetchedAt: number;
}

/** Who reacted with one emoji, as Discord's tooltip names them: the first few, then a count of the rest. */
export interface ReactionUsers {
  people: PersonMatch[];
  /** The reaction's count when Discord answered: a different count now means the list is stale. */
  count: number;
  fetchedAt: number;
}

/** Discord's profile answer (users/<id>/profile), the fields ChattyPop reads; kept whole in the cache. */
export interface RawProfile {
  user: RawUser & { banner?: string | null; accent_color?: number | null; bio?: string };
  user_profile?: { bio?: string; pronouns?: string; accent_color?: number | null; banner?: string | null };
  badges?: { id: string; description: string; icon: string; link?: string }[];
  mutual_guilds?: { id: string; nick: string | null }[];
  mutual_friends_count?: number;
  connected_accounts?: { type: string; name: string; verified?: boolean }[];
  guild_member?: { joined_at?: string; nick?: string | null; roles?: string[]; bio?: string };
  guild_member_profile?: { pronouns?: string; bio?: string };
}

/** What main fetched for a profile, for core to cache. */
export interface FetchedProfile {
  userId: string;
  guildId: string | null;
  raw: RawProfile;
  note: string | null;
  friendsSince: number | null;
  fetchedAt: number;
}
