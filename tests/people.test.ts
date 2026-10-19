import { describe, expect, it } from 'vitest';
import { findPeople, findSearchAuthors, peopleByIds } from '../src/core/queries/people';
import { ARRIVAL } from '../src/core/arrival';
import { applyAccessFacts } from '../src/core/access';
import type { RawRole } from '@shared/discord';
import { PERMISSIONS } from '@shared/permissions';
import { rawMessage, seedArchive, tempDb } from './helpers';

describe('people by name', () => {
  it('finds by display name, username or nickname, treating LIKE wildcards literally', () => {
    const db = tempDb();
    const archive = seedArchive(db, [{ id: 'c1' }]);
    archive.ingestMessages(
      [
        rawMessage('c1', 1, 'a', { author: { id: '1', username: 'tony_t', global_name: 'Tony' } }),
        rawMessage('c1', 2, 'b', { author: { id: '2', username: 'stat', global_name: null }, member: { nick: 'Statler' } } as never),
        rawMessage('c1', 3, 'c', { author: { id: '3', username: 'tonyxt', global_name: 'Other' } }),
      ],
      ARRIVAL.gateway,
    );
    expect(findPeople(db, 'ton', 10).map((p) => p.name)).toEqual(['Other', 'Tony']);
    expect(findPeople(db, 'y_t', 10).map((p) => p.id)).toEqual(['1']);
    expect(findPeople(db, 'statl', 10).map((p) => p.name)).toEqual(['stat']);
    expect(findPeople(db, '  ', 10)).toEqual([]);
    expect(peopleByIds(db, ['2', 'nobody']).map((p) => p.name)).toEqual(['stat']);
  });

  it('ranks names starting with the query before the limit, ahead of ones only containing it', () => {
    const db = tempDb();
    const archive = seedArchive(db, [{ id: 'c1' }]);
    archive.ingestMessages(
      [
        rawMessage('c1', 1, 'a', { author: { id: '1', username: 'xan', global_name: '!Dana' } }),
        rawMessage('c1', 2, 'b', { author: { id: '2', username: 'annie', global_name: 'Zed' } }),
        rawMessage('c1', 3, 'c', { author: { id: '3', username: 'anna', global_name: null } }),
      ],
      ARRIVAL.gateway,
    );
    expect(findPeople(db, 'an', 2).map((p) => p.id)).toEqual(['3', '2']);
    expect(findPeople(db, 'an', 10).map((p) => p.id)).toEqual(['3', '2', '1']);
  });
});

describe('people a search can find', () => {
  const setup = () => {
    const db = tempDb();
    const archive = seedArchive(db, [{ id: 'c1', name: 'general', guildId: 'g1' }, { id: 'c2', name: 'trading', guildId: 'g2' }, { id: 'c3', name: 'random', guildId: 'g1' }], {
      guilds: [{ id: 'g1', name: 'Home' }, { id: 'g2', name: 'Markets' }],
    });
    const by = (id: string, username: string) => ({ author: { id, username, global_name: null } });
    let ts = 0;
    const posts = (channel: string, n: number, id: string, username: string) => Array.from({ length: n }, () => rawMessage(channel, ++ts, 'x', by(id, username)));
    archive.ingestMessages([...posts('c1', 1, 'ann', 'ann'), ...posts('c2', 4, 'bob', 'bob'), ...posts('c1', 2, 'cal', 'cal'), ...posts('c3', 1, 'cal', 'cal')], ARRIVAL.gateway);
    db.prepare("INSERT INTO users (id, username) VALUES ('dee', 'dee')").run(); // known, never posted
    return db;
  };
  const ids = (db: ReturnType<typeof tempDb>, name: string, query: string, shown: string | null = null): string[] =>
    findSearchAuthors(db, name, query, shown, 10).map((p) => p.id);

  it("offers only people who posted, the most active first, and those in the shown channel's server before them", () => {
    const db = setup();
    expect(ids(db, '', '')).toEqual(['bob', 'cal', 'ann']);
    expect(ids(db, '', '', 'c1')).toEqual(['cal', 'ann', 'bob']);
    expect(ids(db, 'a', '', 'c2')).toEqual(['ann', 'cal']); // a name starting with it first
  });

  it("narrows to where the query's in: and server: terms look, as its search does", () => {
    const db = setup();
    expect(ids(db, '', 'in:general from:')).toEqual(['cal', 'ann']);
    expect(ids(db, '', 'server:markets cats')).toEqual(['bob']);
    expect(ids(db, '', '-in:general')).toEqual(['bob', 'cal']);
  });

  it("adds current members who can see where it looks, as the composer's @ does, after those who posted", () => {
    const db = setup();
    const archive = seedArchive(db, []);
    const view = PERMISSIONS.VIEW_CHANNEL.toString();
    // g1's @everyone sees its channels; only Mods see #random.
    archive.applyRoleChange({ kind: 'replace', guildId: 'g1', roles: [{ id: 'g1', name: '@everyone', position: 0, permissions: view }, { id: 'rMods', name: 'Mods', position: 1, permissions: '0' }] as RawRole[] });
    const member = (id: string, roles: string[]) => ({ user: { id, username: id, global_name: null }, nick: null, roles });
    archive.upsertMembers('g1', [member('eve', []), member('mo', ['rMods']), member('gone', [])] as never);
    db.prepare("UPDATE members SET left_at = 1 WHERE user_id = 'gone'").run();
    applyAccessFacts(
      db,
      { owners: [], overwrites: [{ channelId: 'c3', overwrites: [{ id: 'g1', type: 0, allow: '0', deny: view }, { id: 'rMods', type: 0, allow: view, deny: '0' }] }], members: [] },
      Date.now(),
    );
    expect(ids(db, '', '', 'c1')).toEqual(['cal', 'ann', 'eve', 'mo', 'bob']);
    expect(ids(db, '', 'in:random')).toEqual(['cal', 'mo']);
    expect(ids(db, '', 'server:markets')).toEqual(['bob']);
    expect(ids(db, 'e', '')).toEqual(['eve']);
  });

  it('follows messages as they are stored and removed', () => {
    const db = setup();
    db.prepare("DELETE FROM messages WHERE author_id = 'ann'").run();
    expect(ids(db, '', '')).toEqual(['bob', 'cal']);
    db.prepare("DELETE FROM messages WHERE author_id = 'cal' AND channel_id = 'c1'").run();
    expect(ids(db, '', '', 'c1')).toEqual(['cal', 'bob']);
  });
});
