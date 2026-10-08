import { describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, can, channelPermissions, type PermissionContext, type RawOverwrite } from '@shared/permissions';
import { GatewayAccess } from '../src/main/discord/access';
import { MemberRequests } from '../src/main/discord/memberRequests';
import { applyAccessFacts } from '../src/core/access';
import { seedArchive, tempDb } from './helpers';

const { VIEW_CHANNEL, ADMINISTRATOR, MENTION_EVERYONE, SEND_MESSAGES, SEND_MESSAGES_IN_THREADS } = PERMISSIONS;
const bits = (b: bigint): string => b.toString();
const ctx = (overwrites: RawOverwrite[], roles: [string, bigint][] = []): PermissionContext => ({
  guildId: 'g',
  ownerId: 'owner',
  rolePermissions: new Map([['g', VIEW_CHANNEL], ...roles]),
  overwrites,
});
const ow = (id: string, type: number, allow: bigint, deny: bigint): RawOverwrite => ({ id, type, allow: bits(allow), deny: bits(deny) });

describe("Discord's channel permissions", () => {
  it('gives the owner and Administrator everything, whatever the overwrites', () => {
    const hidden = ctx([ow('g', 0, 0n, VIEW_CHANNEL)], [['admin', ADMINISTRATOR]]);
    expect(can(hidden, 'owner', { roles: [] }, VIEW_CHANNEL)).toBe(true);
    expect(can(hidden, 'u', { roles: ['admin'] }, VIEW_CHANNEL | MENTION_EVERYONE)).toBe(true);
    expect(can(hidden, 'u', { roles: [] }, VIEW_CHANNEL)).toBe(false);
  });

  it("applies @everyone's overwrite, then the member's roles' (allow beating deny), then the member's own", () => {
    const c = ctx([ow('g', 0, 0n, VIEW_CHANNEL), ow('a', 0, VIEW_CHANNEL, 0n), ow('b', 0, 0n, VIEW_CHANNEL), ow('x', 1, 0n, VIEW_CHANNEL)]);
    expect(can(c, 'u', { roles: ['a'] }, VIEW_CHANNEL)).toBe(true);
    expect(can(c, 'u', { roles: ['a', 'b'] }, VIEW_CHANNEL)).toBe(true);
    expect(can(c, 'u', { roles: ['b'] }, VIEW_CHANNEL)).toBe(false);
    expect(can(c, 'x', { roles: ['a'] }, VIEW_CHANNEL)).toBe(false);
    expect(channelPermissions(ctx([], [['m', SEND_MESSAGES | MENTION_EVERYONE]]), 'u', { roles: ['m'] })).toBe(VIEW_CHANNEL | SEND_MESSAGES | MENTION_EVERYONE);
  });

  it('takes @everyone away from a member who may not send there: in a thread, by Send Messages in Threads', () => {
    const pinger = ctx([], [['m', MENTION_EVERYONE]]);
    expect(can(pinger, 'u', { roles: ['m'] }, MENTION_EVERYONE)).toBe(false);
    const muted = ctx([ow('g', 0, 0n, SEND_MESSAGES)], [['m', SEND_MESSAGES | MENTION_EVERYONE]]);
    expect(can(muted, 'u', { roles: ['m'] }, MENTION_EVERYONE)).toBe(false);
    const sender = ctx([], [['m', SEND_MESSAGES | MENTION_EVERYONE]]);
    expect(can(sender, 'u', { roles: ['m'] }, MENTION_EVERYONE)).toBe(true);
    expect(can({ ...sender, thread: true }, 'u', { roles: ['m'] }, MENTION_EVERYONE)).toBe(false);
    const threadSender = ctx([], [['m', SEND_MESSAGES_IN_THREADS | MENTION_EVERYONE]]);
    expect(can({ ...threadSender, thread: true }, 'u', { roles: ['m'] }, MENTION_EVERYONE)).toBe(true);
  });

  it('leaves a timed-out member only seeing and reading, until the timeout ends; not the owner or Administrator', () => {
    const NOW = 1_000_000;
    const c = ctx([], [['m', SEND_MESSAGES | MENTION_EVERYONE], ['admin', ADMINISTRATOR]]);
    expect(can(c, 'u', { roles: ['m'], timedOutUntil: NOW + 1 }, VIEW_CHANNEL, NOW)).toBe(true);
    expect(can(c, 'u', { roles: ['m'], timedOutUntil: NOW + 1 }, MENTION_EVERYONE, NOW)).toBe(false);
    expect(can(c, 'u', { roles: ['m'], timedOutUntil: NOW - 1 }, MENTION_EVERYONE, NOW)).toBe(true);
    expect(can(c, 'u', { roles: ['admin'], timedOutUntil: NOW + 1 }, MENTION_EVERYONE, NOW)).toBe(true);
    expect(can(c, 'owner', { roles: [], timedOutUntil: NOW + 1 }, MENTION_EVERYONE, NOW)).toBe(true);
  });
});

describe('who can see a channel, from the gateway', () => {
  it("reads READY's owners, overwrites and the owner's roles, and stores them for archived servers and channels", () => {
    const view = ow('g1', 0, 0n, VIEW_CHANNEL);
    const access = new GatewayAccess();
    const facts = access.read('READY', {
      user: { id: 'me' },
      guilds: [{ id: 'g1', properties: { name: 'G1', owner_id: 'boss' }, channels: [{ id: 'c1', name: 'c1', type: 0, permission_overwrites: [view] }] }],
      merged_members: [[{ user_id: 'me', nick: 'Me', roles: ['r1'] }]],
    });
    expect(facts).toEqual({ owners: [{ guildId: 'g1', name: 'G1', ownerId: 'boss' }], overwrites: [{ channelId: 'c1', overwrites: [view] }], members: [{ guildId: 'g1', userId: 'me', nick: 'Me', roles: ['r1'] }] });
    expect(access.read('GUILD_UPDATE', { id: 'g1', owner_id: 'new' })?.owners).toEqual([{ guildId: 'g1', name: null, ownerId: 'new' }]);
    expect(access.read('MESSAGE_CREATE', {})).toBeNull();
    // The owner's roles also come after READY, and with each server that becomes available.
    expect(access.read('READY_SUPPLEMENTAL', { guilds: [{ id: 'g2' }], merged_members: [[{ user_id: 'me', roles: ['r2'] }]] })?.members).toEqual([
      { guildId: 'g2', userId: 'me', nick: null, roles: ['r2'] },
    ]);
    expect(access.read('GUILD_CREATE', { id: 'g3', members: [{ user: { id: 'x' }, roles: ['rx'] }, { user: { id: 'me' }, roles: ['r3'] }] })?.members).toEqual([
      { guildId: 'g3', userId: 'me', nick: null, roles: ['r3'] },
    ]);
    // The owner's timeout rides along, to take @everyone away while it lasts.
    const until = '2026-10-04T12:00:00.000Z';
    expect(access.read('READY_SUPPLEMENTAL', { guilds: [{ id: 'g4' }], merged_members: [[{ user_id: 'me', roles: [], communication_disabled_until: until }]] })?.members).toEqual([
      { guildId: 'g4', userId: 'me', nick: null, roles: [], communicationDisabledUntil: until },
    ]);

    const db = tempDb();
    const archive = seedArchive(db, [{ id: 'c1' }]);
    applyAccessFacts(db, facts!, 1);
    expect(db.prepare('SELECT owner_id FROM guilds WHERE id = ?').pluck().get('g1')).toBe('boss');
    expect(JSON.parse(db.prepare('SELECT overwrites FROM channels WHERE id = ?').pluck().get('c1') as string)).toEqual([view]);
    expect(db.prepare('SELECT roles FROM members WHERE user_id = ?').pluck().get('me')).toBe('["r1"]');
    // A channel list without overwrites keeps the stored ones.
    archive.upsertChannels('g1', [{ id: 'c1', name: 'renamed', type: 0 }]);
    expect(db.prepare('SELECT overwrites FROM channels WHERE id = ?').pluck().get('c1')).not.toBeNull();
    // A server READY names before the server list arrives keeps its owner.
    applyAccessFacts(db, { owners: [{ guildId: 'g9', name: 'Later', ownerId: 'o9' }], overwrites: [], members: [] }, 2);
    expect(db.prepare('SELECT owner_id FROM guilds WHERE id = ?').pluck().get('g9')).toBe('o9');
  });
});

describe('optional member enrichment', () => {
  it('is unavailable immediately and for repeated requests without a transport', async () => {
    const requests = new MemberRequests();
    expect(await requests.request('g1', 'ton')).toBe(false);
    expect(await requests.request('g1', 'ton')).toBe(false);
    expect(await requests.request('g2', 'tony')).toBe(false);
  });

  it('uses only an explicitly supplied transport and reports its availability', async () => {
    const transport = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const requests = new MemberRequests(transport);
    expect(await requests.request('g1', 'ton')).toBe(true);
    expect(await requests.request('g2', 'tony')).toBe(false);
    expect(transport.mock.calls).toEqual([['g1', 'ton'], ['g2', 'tony']]);
  });
});
