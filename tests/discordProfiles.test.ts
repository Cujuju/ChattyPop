// Contract: Discord's profile, mutual-friend and reactor answers are cached as the Person window and the reaction
// tooltip show them, and storing one refreshes the names and roles the archive draws elsewhere.
import { beforeEach, describe, expect, it } from 'vitest';
import type { RawRole } from '@shared/discord';
import type { FetchedProfile } from '@shared/types/discordProfile';
import type { Db } from '../src/core/db';
import type { Archive } from '../src/core/archive';
import { cachedMutualFriends, cachedProfile, cachedReactors, storeMutualFriends, storeProfile, storeReactors } from '../src/core/discordProfiles';
import { messagePage } from '../src/core/queries/messages';
import { rawMessage, seedArchive, tempDb } from './helpers';
import { ARRIVAL } from '../src/core/arrival';

const GUILD = '100000000000000001';
const OTHER_GUILD = '100000000000000002';
const GENERAL = '200000000000000001';
const T0 = Date.UTC(2026, 8, 1);
const alice = { id: '300000000000000001', username: 'alice', global_name: 'Alice' };
const bob = { id: '300000000000000002', username: 'bob', global_name: 'Bob' };
const MOD = { id: '400000000000000001', name: 'Mod', position: 5, color: 0xf47fff } satisfies RawRole;
const MEMBER = { id: '400000000000000002', name: 'Member', position: 1, color: 0 } satisfies RawRole;

let db: Db;
let archive: Archive;
beforeEach(() => {
  db = tempDb();
  archive = seedArchive(db, [{ id: GENERAL }], { guilds: [{ id: GUILD, name: 'Guild' }, { id: OTHER_GUILD, name: 'Other' }] });
  archive.applyRoleChange({ kind: 'replace', guildId: GUILD, roles: [MOD, MEMBER] });
});

const fetched = (over: Partial<FetchedProfile['raw']> = {}): FetchedProfile => ({
  userId: alice.id,
  guildId: GUILD,
  raw: {
    user: { ...alice, banner: 'b'.repeat(32), accent_color: 0x55026b, bio: 'user bio' },
    user_profile: { bio: 'user bio', pronouns: 'she/her' },
    badges: [{ id: 'quest_completed', description: 'Completed a Quest', icon: 'c'.repeat(32), link: 'https://discord.com/discovery/quests' }],
    mutual_guilds: [{ id: GUILD, nick: null }, { id: OTHER_GUILD, nick: 'Al' }, { id: '100000000000000009', nick: null }],
    mutual_friends_count: 2,
    guild_member: { joined_at: '2025-09-17T16:35:09.015000+00:00', nick: 'Ally', roles: [MEMBER.id, MOD.id] },
    ...over,
  },
  note: 'met at the meetup',
  friendsSince: T0,
  fetchedAt: T0,
});

describe("Discord's profile cache", () => {
  it('reads back as the profile window shows it: roles highest first, known mutual servers, member fields', () => {
    expect(cachedProfile(db, alice.id, GUILD)).toBeNull();
    storeProfile(db, fetched());
    expect(cachedProfile(db, alice.id, GUILD)).toMatchObject({
      banner: 'b'.repeat(32),
      accentColor: 0x55026b,
      bio: 'user bio',
      pronouns: 'she/her',
      joinedAt: Date.parse('2025-09-17T16:35:09.015Z'),
      roles: [{ id: MOD.id, name: 'Mod', color: MOD.color }, { id: MEMBER.id, name: 'Member', color: null }],
      note: 'met at the meetup',
      friendsSince: T0,
      mutualGuilds: [{ id: GUILD, name: 'Guild' }, { id: OTHER_GUILD, name: 'Other', nick: 'Al' }],
      mutualFriendsCount: 2,
      badges: [{ id: 'quest_completed', link: 'https://discord.com/discovery/quests' }],
      fetchedAt: T0,
    });
    // Outside a server the cache keeps a separate answer.
    expect(cachedProfile(db, alice.id, null)).toBeNull();
  });

  it("prefers the server profile's bio and pronouns", () => {
    storeProfile(db, fetched({ guild_member: { roles: [], bio: 'server bio' }, guild_member_profile: { pronouns: 'any' } }));
    expect(cachedProfile(db, alice.id, GUILD)).toMatchObject({ bio: 'server bio', pronouns: 'any' });
  });

  it("refreshes the member's nickname and roles the archive draws on their messages", () => {
    archive.ingestMessages([rawMessage(GENERAL, T0, 'hi', { author: alice })], ARRIVAL.gateway);
    storeProfile(db, { ...fetched(), fetchedAt: T0 + 1 });
    expect(messagePage(db, { channelId: GENERAL, limit: 10 }).at(-1)!.author).toMatchObject({ name: 'Ally', color: MOD.color });
  });

  it('lists mutual friends and reactors in Discord’s order, named as the archive names them', () => {
    expect(storeMutualFriends(db, alice.id, [bob, alice], T0).people.map((p) => p.name)).toEqual(['Bob', 'Alice']);
    expect(cachedMutualFriends(db, alice.id)?.fetchedAt).toBe(T0);
    expect(cachedReactors(db, 'm1', '🔥')).toBeNull();
    storeReactors(db, 'm1', '🔥', [alice, bob], 5, T0);
    expect(cachedReactors(db, 'm1', '🔥')).toEqual({ people: [expect.objectContaining({ id: alice.id }), expect.objectContaining({ id: bob.id })], count: 5, fetchedAt: T0 });
  });
});
