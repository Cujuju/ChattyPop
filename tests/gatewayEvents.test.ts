import { beforeEach, describe, expect, it } from 'vitest';
import { isArchivedGatewayEvent } from '@shared/types/ipc';
import type { Archive } from '../src/core/archive';
import type { Db } from '../src/core/db';
import { applyGatewayEvent } from '../src/core/gatewayEvents';
import { messagesByIds } from '../src/core/queries/messages';
import { ARRIVAL } from '../src/core/arrival';
import { rawMessage, seedArchive, tempDb } from './helpers';

const CH = '200000000000000001';
const OTHER = '200000000000000002';
const NOW = Date.UTC(2026, 8, 25);

let db: Db;
let a: Archive;
let changed: string[];
const SELF = '100000000000000001';
const FRIEND = '100000000000000002';
let activity: [string, string][];
const deps = {
  changed: (id: string) => changed.push(id),
 
  backfillFromMs: () => 0,
  selfId: () => SELF,
  dmActivity: (channelId: string, lastMessageId: string) => activity.push([channelId, lastMessageId]),
  autoArchiveSinceMs: () => null,
  optedIn: () => undefined,
};
const row = (id: string) => db.prepare('SELECT content, deleted_at FROM messages WHERE id = ?').get(id) as { content: string; deleted_at: number | null } | undefined;

beforeEach(() => {
  db = tempDb();
  a = seedArchive(db, [{ id: CH }, { id: OTHER, optIn: false }]);
  changed = [];
  activity = [];
});

describe('gateway events', () => {
  it('archives, edits and deletes messages in opted-in channels, reporting each change', () => {
    const m = rawMessage(CH, NOW, 'hello');
    applyGatewayEvent(a, 'MESSAGE_CREATE', m, deps);
    expect(row(m.id)?.content).toBe('hello');
    applyGatewayEvent(a, 'MESSAGE_UPDATE', { ...m, content: 'hello again', edited_timestamp: new Date(NOW + 1).toISOString() }, deps);
    expect(row(m.id)?.content).toBe('hello again');
    applyGatewayEvent(a, 'MESSAGE_DELETE', { id: m.id, channel_id: CH }, deps);
    expect(row(m.id)?.deleted_at).not.toBeNull();
    expect(changed).toEqual([CH, CH, CH]);
  });

  it('ignores channels that are not archived', () => {
    const m = rawMessage(OTHER, NOW, 'not archived');
    applyGatewayEvent(a, 'MESSAGE_CREATE', m, deps);
    applyGatewayEvent(a, 'MESSAGE_DELETE_BULK', { ids: [m.id], channel_id: OTHER }, deps);
    expect(row(m.id)).toBeUndefined();
    expect(changed).toEqual([]);
  });
});

describe('passively observed identities', () => {
  const person = { id: FRIEND, username: 'friend', global_name: 'Friend', avatar: 'old' };
  const user = () => db.prepare('SELECT username, global_name, avatar FROM users WHERE id = ?').get(FRIEND);
  const member = (guildId = 'g1') => db.prepare('SELECT nick, roles, left_at FROM members WHERE guild_id = ? AND user_id = ?').get(guildId, FRIEND);

  it('seeds historical mentions without rolling back known identity facts, while live mentions can refresh them', () => {
    applyGatewayEvent(a, 'READY', { users: [{ ...person, avatar: 'new' }] }, deps);
    const historical = rawMessage(CH, NOW, 'history', { mentions: [{ ...person, username: 'oldname', avatar: 'old' }, { id: 'unknown', username: 'seeded' }] });
    a.ingestMessages([historical], ARRIVAL.sync);
    expect(user()).toMatchObject({ username: 'friend', avatar: 'new' });
    expect(db.prepare('SELECT username FROM users WHERE id = ?').pluck().get('unknown')).toBe('seeded');
    a.ingestMessages([rawMessage(CH, NOW + 1, 'import', { mentions: [{ ...person, avatar: 'imported' }] })], ARRIVAL.import);
    expect(user()).toMatchObject({ avatar: 'new' });
    applyGatewayEvent(a, 'MESSAGE_UPDATE', { id: historical.id, channel_id: CH, mentions: [{ ...person, avatar: 'latest' }] }, deps);
    expect(user()).toMatchObject({ avatar: 'latest' });
  });

  it('forwards READY identities and joins merged member references without storing message content', () => {
    expect(isArchivedGatewayEvent('READY')).toBe(true);
    applyGatewayEvent(a, 'READY', {
      users: [person], user: { id: SELF, username: 'self' },
      guilds: [{ id: 'g1' }, { id: 'g2' }],
      merged_members: [[{ user_id: FRIEND, nick: 'Pal', roles: ['r1'] }], [{ user_id: FRIEND, nick: 'Other', roles: [] }]],
    }, deps);
    expect(user()).toEqual({ username: 'friend', global_name: 'Friend', avatar: 'old' });
    expect(member()).toMatchObject({ nick: 'Pal', roles: '["r1"]' });
    expect(member('g2')).toMatchObject({ nick: 'Other', roles: '[]' });
    expect(db.prepare('SELECT COUNT(*) FROM messages').pluck().get()).toBe(0);
    expect(changed).toEqual([]);
  });

  it('learns available members from supplemental and guild snapshots; presence alone supplies no membership', () => {
    for (const t of ['READY_SUPPLEMENTAL', 'GUILD_CREATE', 'USER_UPDATE', 'PRESENCE_UPDATE'] as const) expect(isArchivedGatewayEvent(t)).toBe(true);
    applyGatewayEvent(a, 'READY_SUPPLEMENTAL', { users: [person], guilds: [{ id: 'g1' }], merged_members: [[{ user_id: FRIEND, roles: [] }]] }, deps);
    applyGatewayEvent(a, 'GUILD_CREATE', { id: 'g2', members: [{ user: person, nick: 'Pal' }], presences: [{ user: { id: 'presence', username: 'present' } }] }, deps);
    expect(member()).toMatchObject({ roles: '[]' });
    expect(member('g2')).toMatchObject({ nick: 'Pal' });
    expect(db.prepare('SELECT username FROM users WHERE id = ?').pluck().get('presence')).toBe('present');
    expect(db.prepare('SELECT 1 FROM members WHERE user_id = ?').get('presence')).toBeUndefined();
  });

  it('merges partial identity and member updates, preserving omissions and clearing explicit nulls', () => {
    applyGatewayEvent(a, 'GUILD_MEMBER_ADD', { guild_id: 'g1', user: person, nick: 'Pal', roles: ['r1'] }, deps);
    applyGatewayEvent(a, 'PRESENCE_UPDATE', { guild_id: 'g2', user: { id: FRIEND, global_name: 'Renamed', avatar: null } }, deps);
    applyGatewayEvent(a, 'GUILD_MEMBER_UPDATE', { guild_id: 'g1', user: { id: FRIEND }, roles: [] }, deps);
    expect(user()).toEqual({ username: 'friend', global_name: 'Renamed', avatar: null });
    expect(member()).toMatchObject({ nick: 'Pal', roles: '[]' });
    expect(member('g2')).toBeUndefined();
    applyGatewayEvent(a, 'GUILD_MEMBER_LIST_UPDATE', { guild_id: 'g1', ops: [{ item: { member: { user: { id: FRIEND } } } }] }, deps);
    expect(member()).toMatchObject({ nick: 'Pal', roles: '[]' });
    applyGatewayEvent(a, 'GUILD_MEMBER_UPDATE', { guild_id: 'g1', user: { id: FRIEND }, nick: null }, deps);
    applyGatewayEvent(a, 'USER_UPDATE', { id: FRIEND, username: 'newname', global_name: null }, deps);
    expect(member()).toMatchObject({ nick: null, roles: '[]' });
    expect(user()).toEqual({ username: 'newname', global_name: null, avatar: null });
  });

  it('keeps unknown ids nameless, but retains explicit membership until the name arrives', () => {
    applyGatewayEvent(a, 'PRESENCE_UPDATE', { user: { id: FRIEND } }, deps);
    expect(user()).toBeUndefined();
    expect(member()).toBeUndefined();
    applyGatewayEvent(a, 'GUILD_MEMBER_UPDATE', { guild_id: 'g1', user: { id: FRIEND }, nick: 'Pal', roles: [] }, deps);
    expect(user()).toBeUndefined();
    expect(member()).toMatchObject({ nick: 'Pal' });
    applyGatewayEvent(a, 'USER_UPDATE', person, deps);
    expect(user()).toMatchObject({ username: 'friend' });
    expect(member()).toMatchObject({ nick: 'Pal' });
  });

  it('learns mentioned identities only from archived messages and requires explicit member facts', () => {
    const mention = { ...person, member: { nick: 'Pal', roles: [] } };
    applyGatewayEvent(a, 'MESSAGE_CREATE', rawMessage(OTHER, NOW, 'not archived', { mentions: [mention] }), deps);
    expect(user()).toBeUndefined();
    expect(member()).toBeUndefined();
    const m = rawMessage(CH, NOW, 'hello', { mentions: [person] });
    applyGatewayEvent(a, 'MESSAGE_CREATE', m, deps);
    expect(user()).toMatchObject({ username: 'friend' });
    expect(member()).toBeUndefined();
    applyGatewayEvent(a, 'MESSAGE_UPDATE', { id: m.id, channel_id: CH, mentions: [mention] }, deps);
    expect(member()).toMatchObject({ nick: 'Pal', roles: '[]' });
  });
});

describe('reactions', () => {
  const THUMBS = { id: null, name: '👍', animated: false };
  const reactions = (id: string) => messagesByIds(db, [id])[0]!.reactions;
  const react = (t: 'MESSAGE_REACTION_ADD' | 'MESSAGE_REACTION_REMOVE', id: string, userId: string) =>
    applyGatewayEvent(a, t, { channel_id: CH, message_id: id, emoji: THUMBS, user_id: userId }, deps);

  it("counts everyone's reactions and marks the owner's own", () => {
    const m = rawMessage(CH, NOW, 'vote');
    applyGatewayEvent(a, 'MESSAGE_CREATE', m, deps);
    react('MESSAGE_REACTION_ADD', m.id, FRIEND);
    expect(reactions(m.id)).toEqual([{ emoji: THUMBS, count: 1, me: false }]);
    react('MESSAGE_REACTION_ADD', m.id, SELF);
    expect(reactions(m.id)).toEqual([{ emoji: THUMBS, count: 2, me: true }]);
    react('MESSAGE_REACTION_REMOVE', m.id, SELF);
    expect(reactions(m.id)).toEqual([{ emoji: THUMBS, count: 1, me: false }]);
  });

  it("the owner's reaction arriving twice (main's copy, then the gateway's) counts once", () => {
    const m = rawMessage(CH, NOW, 'vote');
    applyGatewayEvent(a, 'MESSAGE_CREATE', m, deps);
    const own = { channel_id: CH, message_id: m.id, emoji: THUMBS, user_id: SELF };
    expect(a.applyReaction('MESSAGE_REACTION_ADD', own, SELF)).toBe(true);
    changed = [];
    react('MESSAGE_REACTION_ADD', m.id, SELF);
    expect(reactions(m.id)).toEqual([{ emoji: THUMBS, count: 1, me: true }]);
    expect(changed).toEqual([]);
    expect(a.applyReaction('MESSAGE_REACTION_REMOVE', own, SELF)).toBe(true);
    react('MESSAGE_REACTION_REMOVE', m.id, SELF);
    expect(reactions(m.id)).toEqual([]);
  });
});
