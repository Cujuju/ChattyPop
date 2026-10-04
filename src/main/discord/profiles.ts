// What Discord's client fetches when a name is clicked (profile, note), a profile's Mutual Friends tab is
// opened or a reaction is hovered; asked as the client asks, through the embedded session. Callers pass
// DiscordApi.prompt: the owner is waiting. Message goes through the DM service (dms.ts).
import { HTTP_NOT_FOUND, DiscordHttpError, reactionPathPart, type RawUser } from '@shared/discord';
import type { ArchiveEmoji } from '@shared/contract';
import type { Friend } from '@shared/dms';
import type { FetchedProfile, RawProfile } from '@shared/types/discordProfile';
import type { DiscordReader } from './client';
import type { GatewayTap } from './gatewayTap';

/** Discord's relationship type for a friend. */
const FRIEND_RELATIONSHIP = 1;
/** Reactors fetched per emoji: the names Discord's tooltip shows (Assumption: three, then "and N others"). */
export const REACTORS_FETCHED = 3;
/** Discord's reaction type for a normal (not super) reaction. */
const NORMAL_REACTION = 0;

interface RawRelationship {
  id: string;
  type: number;
  /** ISO time the relationship began. */
  since?: string;
  /** The person; READY may name them by `user_id` in its `users` instead. */
  user?: RawUser;
  user_id?: string;
}

interface FriendEntry {
  /** Null while no payload has named them. */
  user: RawUser | null;
  since: number | null;
}

/** The owner's friends, with since when and their names and faces, from the client's gateway (READY, RELATIONSHIP_*). */
export class FriendIndex {
  private readonly friends = new Map<string, FriendEntry>();

  /** Subscribe before the client opens its socket (as the tap requires), or READY is missed. */
  constructor(tap: GatewayTap) {
    tap.on('dispatch', ({ t, d }) => {
      if (t === 'READY') {
        const ready = d as { relationships?: RawRelationship[]; users?: RawUser[] };
        const users = new Map((ready.users ?? []).map((u) => [u.id, u]));
        this.friends.clear();
        for (const r of ready.relationships ?? []) this.put(r, users);
      } else if (t === 'RELATIONSHIP_ADD' || t === 'RELATIONSHIP_UPDATE') this.put(d as RawRelationship, new Map());
      else if (t === 'RELATIONSHIP_REMOVE') this.friends.delete((d as RawRelationship).id);
    });
  }

  /** When they became friends (ms); null when not friends, or Discord didn't say. */
  friendsSince(userId: string): number | null {
    return this.friends.get(userId)?.since ?? null;
  }

  isFriend(userId: string): boolean {
    return this.friends.has(userId);
  }

  /** A friend as Discord named them; undefined when not a friend or not named yet. */
  user(userId: string): RawUser | undefined {
    return this.friends.get(userId)?.user ?? undefined;
  }

  /** Friends whose names are known, by name. */
  list(): Friend[] {
    return [...this.friends.values()]
      .flatMap(({ user, since }) => (user ? [{ id: user.id, name: user.global_name || user.username, username: user.username, avatar: user.avatar ?? null, since }] : []))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** An update without a person or a since keeps what was known. */
  private put(r: RawRelationship, users: ReadonlyMap<string, RawUser>): void {
    if (r.type !== FRIEND_RELATIONSHIP) return void this.friends.delete(r.id);
    const prior = this.friends.get(r.id);
    const user = r.user ?? users.get(r.user_id ?? r.id) ?? prior?.user ?? null;
    this.friends.set(r.id, { user, since: r.since ? Date.parse(r.since) : (prior?.since ?? null) });
  }
}

/** A person's profile as seen in `guildId` (null outside a server), with the owner's note about them. */
export async function fetchProfile(api: DiscordReader, friends: FriendIndex, userId: string, guildId: string | null): Promise<FetchedProfile> {
  // Both queued at once, as the client asks for them together, so no other request goes out between them.
  const [raw, note] = await Promise.all([
    api.get<RawProfile>(`users/${userId}/profile`, {
      type: 'modal',
      with_mutual_guilds: 'true',
      with_mutual_friends: 'false',
      with_mutual_friends_count: 'true',
      guild_id: guildId ?? undefined,
    }),
    // No note answers 404.
    api.get<{ note?: string }>(`users/@me/notes/${userId}`).then(
      (n) => n.note || null,
      (err: unknown) => {
        if (err instanceof DiscordHttpError && err.status === HTTP_NOT_FOUND) return null;
        throw err;
      },
    ),
  ]);
  return { userId, guildId, raw, note, friendsSince: friends.friendsSince(userId), fetchedAt: Date.now() };
}

export const fetchMutualFriends = (api: DiscordReader, userId: string): Promise<RawUser[]> => api.get<RawUser[]>(`users/${userId}/relationships`);

export const fetchReactors = (api: DiscordReader, channelId: string, messageId: string, emoji: ArchiveEmoji): Promise<RawUser[]> =>
  api.get<RawUser[]>(`channels/${channelId}/messages/${messageId}/reactions/${reactionPathPart(emoji)}`, { limit: REACTORS_FETCHED, type: NORMAL_REACTION });
