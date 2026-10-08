import { beforeEach, describe, expect, it } from 'vitest';
import { MS_PER_MIN } from '@shared/units';
import type { Db } from '../src/core/db';
import type { Archive } from '../src/core/archive';
import { applyGatewayEvent } from '../src/core/gatewayEvents';
import { messagePage, ownAuthor } from '../src/core/queries/messages';
import { rawMessage, seedArchive, tempDb } from './helpers';
import { ARRIVAL } from '../src/core/arrival';

const GUILD = '100000000000000001';
const OTHER_GUILD = '100000000000000002';
const GENERAL = '200000000000000001';
const ELSEWHERE = '200000000000000002';
const T0 = Date.UTC(2026, 8, 1);
const deps = { changed: () => undefined, backfillFromMs: () => 0, selfId: () => null, dmActivity: () => undefined, autoArchiveSinceMs: () => null, optedIn: () => undefined };

let db: Db;
let archive: Archive;
beforeEach(() => {
  db = tempDb();
  archive = seedArchive(db, [{ id: GENERAL }, { id: ELSEWHERE, guildId: OTHER_GUILD }], {
    guilds: [
      { id: GUILD, name: 'Guild' },
      { id: OTHER_GUILD, name: 'Other' },
    ],
  });
});

const author = (channelId: string) => messagePage(db, { channelId, limit: 10 }).at(-1)!.author;
const alice = { id: '300000000000000001', username: 'alice', global_name: 'Alice' };

describe('names as Discord shows them', () => {
  it("uses the server nickname a live message carries, with the account name beside it, only in that server", () => {
    archive.ingestMessages([rawMessage(GENERAL, T0, 'hi', { author: alice, member: { nick: 'Al [mod]' } })], ARRIVAL.gateway);
    archive.ingestMessages([rawMessage(ELSEWHERE, T0 + MS_PER_MIN, 'hey', { author: alice })], ARRIVAL.gateway);
    expect(author(GENERAL)).toMatchObject({ name: 'Al [mod]', username: 'alice' });
    expect(author(ELSEWHERE)).toMatchObject({ name: 'Alice', username: 'alice' });
  });

  it('keeps nicknames current from member events, and an older message never undoes a newer nickname', () => {
    archive.ingestMessages([rawMessage(GENERAL, T0, 'hi', { author: alice })], ARRIVAL.gateway);
    applyGatewayEvent(archive, 'GUILD_MEMBERS_CHUNK', { guild_id: GUILD, members: [{ user: alice, nick: 'Chunked' }] }, deps);
    expect(author(GENERAL).name).toBe('Chunked');

    // A message from before the event, carrying the old nickname, is ingested late (history sync).
    archive.ingestMessages([rawMessage(GENERAL, T0 - MS_PER_MIN, 'old', { author: alice, member: { nick: 'Old nick' } })], ARRIVAL.gateway);
    expect(author(GENERAL).name).toBe('Chunked');

    applyGatewayEvent(archive, 'GUILD_MEMBER_LIST_UPDATE', { guild_id: GUILD, ops: [{ op: 'UPDATE', item: { member: { user: alice, nick: null } } }] }, deps);
    expect(author(GENERAL).name).toBe('Alice');
  });

  it('names @mentions by the nickname in the message’s server', () => {
    archive.upsertMembers(GUILD, [{ user: alice, nick: 'Al [mod]' }]);
    archive.ingestMessages([rawMessage(GENERAL, T0, 'ping <@300000000000000001>', { author: { id: '300000000000000002', username: 'bob' } })], ARRIVAL.gateway);
    expect(messagePage(db, { channelId: GENERAL, limit: 10 })[0]!.mentions['300000000000000001']).toBe('Al [mod]');
  });
});

describe('who a message pings (the Archive highlights the owner’s)', () => {
  it('reports the users Discord pinged and a pinging @everyone, per message', () => {
    const bob = { id: '300000000000000002', username: 'bob' };
    archive.ingestMessages(
      [
        rawMessage(GENERAL, T0, 'ping <@300000000000000001>', { author: bob, mentions: [alice] }),
        rawMessage(GENERAL, T0 + MS_PER_MIN, '@everyone look', { author: bob, mention_everyone: true }),
        rawMessage(GENERAL, T0 + 2 * MS_PER_MIN, 'no ping', { author: bob }),
      ],
      ARRIVAL.gateway,
    );
    expect(messagePage(db, { channelId: GENERAL, limit: 10 }).map((m) => [m.mentionIds, m.mentionsEveryone])).toEqual([
      [[alice.id], false],
      [[], true],
      [[], false],
    ]);
  });
});

describe("the owner's face on a message on its way", () => {
  it('is drawn as their archived messages in that channel are, with no message of theirs loaded; null before the archive knows them', () => {
    expect(ownAuthor(db, alice.id, GENERAL)).toBeNull();
    expect(ownAuthor(db, null, GENERAL)).toBeNull();
    archive.ingestMessages([rawMessage(ELSEWHERE, T0, 'hey', { author: { ...alice, avatar: 'a'.repeat(32) } })], ARRIVAL.gateway);
    applyGatewayEvent(archive, 'GUILD_MEMBERS_CHUNK', { guild_id: GUILD, members: [{ user: alice, nick: 'Al [mod]' }] }, deps);
    expect(ownAuthor(db, alice.id, GENERAL)).toEqual(expect.objectContaining({ id: alice.id, name: 'Al [mod]', username: 'alice', app: null }));
    expect(ownAuthor(db, alice.id, ELSEWHERE)).toEqual(author(ELSEWHERE));
  });
});
