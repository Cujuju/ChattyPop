import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, can, channelPermissions, type PermissionContext, type RawOverwrite } from '@shared/permissions';
import { GatewayAccess } from '../src/main/discord/access';
import type { GatewayDispatch, GatewayTap } from '../src/main/discord/gatewayTap';
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

describe("member searches on the client's gateway socket", () => {
  /** `lostReply`: CDP fails after the page sent the frame, so whether it went is unknown. */
  function fake(open = true, lostReply = false, perWindow?: number) {
    const tap = new EventEmitter<{ dispatch: [GatewayDispatch] }>();
    const frames: unknown[] = [];
    let lookups = 0;
    const cdp = {
      sendCommand: (method: string, params?: Record<string, unknown>): Promise<unknown> => {
        if (method === 'Runtime.evaluate') return Promise.resolve({ result: { objectId: 'proto' } });
        if (method === 'Runtime.queryObjects') return Promise.resolve({ objects: { objectId: 'all' } });
        if (method === 'Runtime.callFunctionOn' && params?.['objectId'] === 'all') return Promise.resolve({ result: { objectId: open ? `socket${++lookups}` : undefined } });
        if (method === 'Runtime.callFunctionOn') {
          frames.push(JSON.parse((params!['arguments'] as { value: string }[])[0]!.value));
          return lostReply ? Promise.reject(new Error('Target closed')) : Promise.resolve({ result: { value: true } });
        }
        return Promise.resolve({});
      },
    };
    return { requests: new MemberRequests(cdp as never, Object.assign(tap, { own: () => undefined }) as unknown as GatewayTap, perWindow), tap, frames, lookups: () => lookups };
  }

  const nonceOf = (frame: unknown): string => (frame as { d: { nonce: string } }).d.nonce;

  it('sends op 8 as the client does, once per server and text in a session, finding the socket once', async () => {
    const f = fake();
    expect(await f.requests.request('g1', ' Ton ')).toBe(true);
    await f.requests.request('g1', 'ton');
    await f.requests.request('g1', 'tony');
    const search = (query: string) => ({ op: 8, d: { guild_id: ['g1'], query, limit: 10, presences: true, nonce: expect.stringMatching(/^[0-9a-f]{32}$/) } });
    expect(f.frames).toEqual([search('ton'), search('tony')]);
    expect(f.lookups()).toBe(1);
    f.tap.emit('dispatch', { t: 'READY', s: 1, d: {} });
    await f.requests.request('g1', 'ton');
    expect(f.frames).toHaveLength(3);
    expect(f.lookups()).toBe(2);
  });

  it('runs concurrent searches one at a time, so a lookup never frees a handle another is using; a newer one for its server replaces a queued one', async () => {
    const f = fake();
    const sent = await Promise.all([f.requests.request('g1', 'a'), f.requests.request('g2', 'b'), f.requests.request('g1', 'c')]);
    expect(sent).toEqual([true, true, true]);
    expect(f.frames.map((fr) => (fr as { d: { query: string } }).d.query)).toEqual(['b', 'c']);
    expect(f.lookups()).toBe(1);
  });

  it("sends at once until the window's share is used, then when the oldest leaves it; and waits out Discord's RATE_LIMITED for op 8", async () => {
    vi.useFakeTimers();
    try {
      const PER_WINDOW = 2;
      const WINDOW_MS = 60_000;
      const RETRY_S = 5;
      const f = fake(true, false, PER_WINDOW);
      await f.requests.request('g1', 'ann');
      await vi.advanceTimersByTimeAsync(1);
      await f.requests.request('g1', 'bob');
      expect(f.frames).toHaveLength(2);
      const next = f.requests.request('g2', 'cy');
      await vi.advanceTimersByTimeAsync(WINDOW_MS - 2);
      expect(f.frames).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      await next;
      expect(f.frames).toHaveLength(3);
      // The window has room again: the RATE_LIMITED wait alone holds the next.
      await vi.advanceTimersByTimeAsync(WINDOW_MS);
      f.tap.emit('dispatch', { t: 'RATE_LIMITED', s: null, d: { opcode: 8, retry_after: RETRY_S, meta: {} } });
      const limited = f.requests.request('g3', 'dee');
      await vi.advanceTimersByTimeAsync(RETRY_S * 1000 - 1);
      expect(f.frames).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      await limited;
      expect(f.frames).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks again for text whose answer never came, once the wait runs out; not for answered text', async () => {
    vi.useFakeTimers();
    try {
      const f = fake();
      await f.requests.request('g1', 'ann');
      await f.requests.request('g1', 'bob');
      f.tap.emit('dispatch', { t: 'GUILD_MEMBERS_CHUNK', s: 2, d: { guild_id: 'g1', members: [], chunk_index: 0, chunk_count: 1, nonce: nonceOf(f.frames[0]) } });
      vi.advanceTimersByTime(60_000);
      await f.requests.request('g1', 'ann');
      await f.requests.request('g1', 'bob');
      expect(f.frames.map((fr) => (fr as { d: { query: string } }).d.query)).toEqual(['ann', 'bob', 'bob']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips text a shorter answer found every match for, in that server, until a new session', async () => {
    const f = fake();
    const answer = (frame: unknown, count: number): void =>
      void f.tap.emit('dispatch', { t: 'GUILD_MEMBERS_CHUNK', s: 2, d: { guild_id: 'g1', members: Array(count).fill({}), chunk_index: 0, chunk_count: 1, nonce: nonceOf(frame) } });
    await f.requests.request('g1', 'an');
    answer(f.frames[0], 3);
    await f.requests.request('g1', 'ann');
    await f.requests.request('g2', 'ann');
    await f.requests.request('g1', 'bo');
    answer(f.frames[2], 10);
    await f.requests.request('g1', 'bob');
    f.tap.emit('dispatch', { t: 'READY', s: 3, d: {} });
    await f.requests.request('g1', 'ann');
    const queries = f.frames.map((fr) => `${(fr as { d: { guild_id: string[] } }).d.guild_id[0]}:${(fr as { d: { query: string } }).d.query}`);
    expect(queries).toEqual(['g1:an', 'g2:ann', 'g1:bo', 'g1:bob', 'g1:ann']);
  });

  it("doesn't resend a search whose send may have gone through", async () => {
    const f = fake(true, true);
    expect(await f.requests.request('g1', 'ton')).toBe(false);
    expect(f.frames).toHaveLength(1);
  });

  it('reports no socket, and asks again later', async () => {
    const f = fake(false);
    expect(await f.requests.request('g1', 'ton')).toBe(false);
    expect(f.frames).toEqual([]);
  });
});
