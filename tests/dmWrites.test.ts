// Validates private-channel writes, recipients, ownership, and Discord limits. Starts send once; uncertain responses remain unretried. Answers merge through the gateway path.
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DM_CHANNEL_TYPE, DiscordHttpError, GROUP_DM_CHANNEL_TYPE, type RawPrivateChannel } from '@shared/discord';
import { GROUP_DM_MAX_MEMBERS } from '@shared/dms';
import { PostingLocked } from '@shared/posting';
import type { GatewayDispatch, GatewayTap } from '../src/main/discord/gatewayTap';
import { BOB, CY, DI, DM, GROUP, GUILD_CHANNEL, NEW, SELF, STRANGER, dmArchive, dmService, friends, people, writer } from './dmFixtures';

const OTHER = '900000000000000002';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));

const { DiscordApi } = await import('../src/main/discord/api');
const { contextProperties } = await import('../src/main/discord/client');
const { DM_CONTEXT, DmService } = await import('../src/main/discord/dms');
const { checkStart } = await import('../src/main/discord/dmChecks');
const { FriendIndex } = await import('../src/main/discord/profiles');

let h: ReturnType<typeof dmArchive>;
beforeEach(() => {
  h = dmArchive();
});
const service = (answer?: (method: string, path: string) => unknown) => dmService(h, answer);
const row = (id: string) => h.row(id);

describe('X-Context-Properties', () => {
  it('is base64 of the JSON {location}, as the client builds it', () => {
    expect(contextProperties({ location: 'New Group DM' })).toBe(Buffer.from('{"location":"New Group DM"}').toString('base64'));
    expect(Buffer.from(contextProperties(DM_CONTEXT.add), 'base64').toString()).toBe('{"location":"Add Friends to DM"}');
  });

  it("is {} (base64 e30=) for a DM opened from a profile or /msg, as the client sends it", async () => {
    expect(contextProperties(DM_CONTEXT.direct)).toBe('e30=');
    const { dms, writes } = service(() => ({ id: NEW, type: DM_CHANNEL_TYPE, recipients: [{ id: STRANGER, username: 'sam' }] }));
    expect(await dms.dmWith(STRANGER)).toBe(NEW);
    expect(writes).toEqual([{ method: 'POST once', path: 'users/@me/channels', body: { recipients: [STRANGER] }, opts: { context: DM_CONTEXT.direct } }]);
  });

  it('rides only on the call that passes it, never on the next', async () => {
    const scripts: string[] = [];
    const page = { isDestroyed: () => false, executeJavaScript: async (s: string) => (scripts.push(s), { status: 200, headers: {}, body: '{}' }) };
    const capture = { current: { authorization: 'token', extra: { 'X-Super-Properties': 'props' } }, invalidate: () => undefined };
    const api = new DiscordApi(() => page as never, capture as never, async () => ({ apiMs: 0, mediaMs: 0, jitter: 0 }));
    await api.prompt.postOnce('users/@me/channels', { recipients: [BOB.id] }, { context: DM_CONTEXT.start });
    await api.prompt.post('channels/1/messages', { content: 'hi' });
    expect(scripts[0]).toContain(`"X-Context-Properties":"${contextProperties(DM_CONTEXT.start)}"`);
    expect(scripts[1]).not.toContain('X-Context-Properties');
    expect(scripts[1]).toContain('X-Super-Properties');
  });
});

describe("a request's guard", () => {
  it('runs after the queue wait, just before sending; a throw sends nothing', async () => {
    const scripts: string[] = [];
    let release = (): void => undefined;
    const answered = { status: 200, headers: {}, body: '' };
    const page = {
      isDestroyed: () => false,
      executeJavaScript: (s: string) =>
        scripts.push(s) === 1 ? new Promise((resolve) => (release = () => resolve(answered))) : Promise.resolve(answered),
    };
    const capture = { current: { authorization: 'token', extra: {} }, invalidate: () => undefined };
    const api = new DiscordApi(() => page as never, capture as never, async () => ({ apiMs: 0, mediaMs: 0, jitter: 0 }));
    let switched = false;
    const first = api.prompt.post('channels/1/messages', { content: 'hi' });
    const guard = (): void => {
      if (switched) throw new Error('Another account');
    };
    const second = api.prompt.patch('channels/2', { name: 'x' }, { guard });
    await new Promise((r) => setTimeout(r));
    // Checked when its turn comes, not when it was queued.
    switched = true;
    release();
    await first;
    await expect(second).rejects.toThrow('Another account');
    expect(scripts).toHaveLength(1);
  });
});

describe('who a new conversation is with', () => {
  it('one person, or a group of friends; each once, never self', () => {
    expect(checkStart([BOB.id, CY.id, BOB.id], SELF, friends)).toEqual([BOB.id, CY.id]);
    // One person needs no friendship: Discord lets the owner message people they share a server with.
    expect(checkStart([STRANGER], SELF, friends)).toEqual([STRANGER]);
    expect(() => checkStart([BOB.id, STRANGER], SELF, friends)).toThrow('Only friends can be in a group.');
    expect(() => checkStart([BOB.id, SELF], SELF, friends)).toThrow("You're in it already");
    expect(() => checkStart([], SELF, friends)).toThrow('Pick who to message.');
    expect(() => checkStart(['bob'], SELF, friends)).toThrow('Not a user id.');
  });

  it(`holds up to ${GROUP_DM_MAX_MEMBERS} people, the owner included`, () => {
    const all = { isFriend: (id: string): boolean => id !== SELF };
    expect(checkStart(people(GROUP_DM_MAX_MEMBERS - 1), SELF, all)).toHaveLength(GROUP_DM_MAX_MEMBERS - 1);
    expect(() => checkStart(people(GROUP_DM_MAX_MEMBERS), SELF, all)).toThrow(`up to ${GROUP_DM_MAX_MEMBERS} people`);
  });
});

describe('starting a conversation', () => {
  it('opens an open DM with no request', async () => {
    const { dms, writes } = service();
    expect(await dms.start([BOB.id])).toEqual({ kind: 'opened', channelId: DM });
    expect(writes).toEqual([]);
  });

  it("posts once, with the client's New Group DM context, and stores Discord's channel at once", async () => {
    const made: RawPrivateChannel = { id: NEW, type: GROUP_DM_CHANNEL_TYPE, name: null, owner_id: SELF, recipients: [BOB, CY], last_message_id: null };
    const { dms, writes } = service(() => made);
    expect(await dms.start([BOB.id, CY.id])).toEqual({ kind: 'created', channelId: NEW });
    expect(writes).toEqual([{ method: 'POST once', path: 'users/@me/channels', body: { recipients: [BOB.id, CY.id] }, opts: { context: DM_CONTEXT.start } }]);
    expect(row(NEW)).toMatchObject({ name: 'Bob, cy', account_id: SELF, owner_id: SELF, closed_at: null });
  });

  it('an answer that may have applied (a server error, no answer) is uncertain: noted, and never sent again', async () => {
    for (const err of [new DiscordHttpError('Discord 502', 502), new Error('Failed to fetch')]) {
      const { dms, writes, notes } = service(() => {
        throw err;
      });
      expect(await dms.start([BOB.id, CY.id])).toEqual({ kind: 'uncertain' });
      expect(writes).toHaveLength(1);
      expect(notes).toEqual([['dm-write-uncertain', { path: 'users/@me/channels' }]]);
    }
  });

  it('posting locked before it went (the transport guard refused it) fails as a refusal, never uncertain', async () => {
    const { dms, notes } = service(() => {
      throw new PostingLocked();
    });
    await expect(dms.start([BOB.id, CY.id])).rejects.toBeInstanceOf(PostingLocked);
    expect(notes).toEqual([]);
  });

  it('a refusal (4xx) fails with its reason and logs its path without ids', async () => {
    const { dms, notes } = service(() => {
      throw new DiscordHttpError('Discord 403 on /api/v9/users/@me/channels: Missing Access', 403);
    });
    await expect(dms.start([STRANGER])).rejects.toThrow('Missing Access');
    expect(notes).toEqual([['dm-write-refused', { path: 'users/@me/channels', status: 403 }]]);
  });

  it('waits for READY to name the account, in main and core alike', async () => {
    const service = (core: string | null, main: string | null) =>
      new DmService({ api: writer().api, core: { call: async () => core } as never, account: () => main, friends, settingsChanged: () => undefined, diag: () => undefined });
    await expect(service(null, null).start([BOB.id])).rejects.toThrow('Discord is still loading');
    // READY for another account reached main, not core yet.
    await expect(service(SELF, OTHER).start([BOB.id])).rejects.toThrow('Discord is still loading');
  });
});

describe('the account a write was checked as', () => {
  const made: RawPrivateChannel = { id: NEW, type: GROUP_DM_CHANNEL_TYPE, name: null, owner_id: SELF, recipients: [BOB, CY] };

  it('is the account it goes as: once another signs in while it waits to be sent, it fails unsent', async () => {
    const { dms, writes } = dmService(h, () => made, undefined, () => h.signIn(OTHER));
    await expect(dms.start([BOB.id, CY.id])).rejects.toThrow('Another Discord account signed in');
    h.signIn(SELF);
    await expect(dms.rename(GROUP, 'plans')).rejects.toThrow('Another Discord account signed in');
    expect(writes).toEqual([]);
  });

  it("is the one its answer is stored under: an answer landing after another account signed in is left to the gateway", async () => {
    const answers = (channel: RawPrivateChannel) => () => (h.signIn(OTHER), channel);
    await dmService(h, answers({ id: GROUP, type: GROUP_DM_CHANNEL_TYPE, name: 'plans' })).dms.rename(GROUP, 'plans');
    expect(row(GROUP)).toMatchObject({ name: 'crew', account_id: SELF });
    h.signIn(SELF);
    expect(await dmService(h, answers(made)).dms.start([BOB.id, CY.id])).toEqual({ kind: 'created', channelId: NEW });
    expect(row(NEW)).toBeUndefined();
  });
});

describe("a write's answer stored at once", () => {
  it('is idempotent with the gateway dispatch that follows it', async () => {
    const made: RawPrivateChannel = { id: NEW, type: GROUP_DM_CHANNEL_TYPE, name: 'plans', owner_id: SELF, recipients: [BOB, CY], last_message_id: null };
    const { dms } = service(() => made);
    await dms.start([BOB.id, CY.id]);
    const stored = row(NEW);
    h.a.upsertPrivateChannel(SELF, made, true);
    expect(row(NEW)).toEqual(stored);
  });
});

describe("a new conversation's archive choice", () => {
  const made: RawPrivateChannel = { id: NEW, type: GROUP_DM_CHANNEL_TYPE, name: null, owner_id: SELF, recipients: [BOB, CY] };

  it('applies as core first stores it, even when the gateway stored it before Discord answered', async () => {
    expect(await service(() => made).dms.start([BOB.id, CY.id], true)).toEqual({ kind: 'created', channelId: NEW });
    expect(row(NEW)).toMatchObject({ opted_in: 1, auto_declined: 0 });
    expect(h.events).toContainEqual({ type: 'opt-in-changed', optedIn: NEW });
    h = dmArchive();
    const gatewayFirst = (): RawPrivateChannel => (void h.call('applyGatewayEvent', 'CHANNEL_CREATE', made), made);
    expect(await service(gatewayFirst).dms.start([BOB.id, CY.id], false)).toEqual({ kind: 'created', channelId: NEW });
    expect(row(NEW)).toMatchObject({ opted_in: 0, auto_declined: 1 });
  });

  it('a DM Discord answers with that core held (a closed one reopened) is opened, and keeps its own state', async () => {
    await h.call('setOptIn', DM, true);
    await h.call('applyGatewayEvent', 'CHANNEL_DELETE', { id: DM, type: DM_CHANNEL_TYPE });
    const { dms, writes } = service(() => ({ id: DM, type: DM_CHANNEL_TYPE, recipients: [BOB] }));
    expect(await dms.start([BOB.id], false)).toEqual({ kind: 'opened', channelId: DM });
    expect(writes).toHaveLength(1);
    expect(row(DM)).toMatchObject({ opted_in: 1, auto_declined: 0, closed_at: null });
  });

  it("is held before any message in the group can auto-archive it, adding to a DM included", async () => {
    h = dmArchive({ autoArchiveSinceMs: 0 });
    const notice = { id: '500000000000000001', channel_id: NEW, author: { id: SELF, username: 'me' }, content: '', timestamp: new Date().toISOString() };
    const { dms } = service((_m, path) => {
      if (path.startsWith(`channels/${DM}/`)) return made;
      // Discord's notice that the second person joined reaches the gateway before the answer.
      void h.call('applyGatewayEvent', 'MESSAGE_CREATE', notice);
      return undefined;
    });
    expect(await dms.add(DM, [CY.id, DI.id], false)).toEqual({ kind: 'created', channelId: NEW });
    expect(row(NEW)).toMatchObject({ opted_in: 0, auto_declined: 1, last_message_id: notice.id });
  });

  it('is a choice, or none', async () => {
    await expect(service().dms.start([BOB.id, CY.id], 'yes')).rejects.toThrow('Archive it, or not.');
  });
});

describe('core checks a write against the account signed in', () => {
  it("knows its own DMs and groups; a server channel or another account's DM is none", () => {
    const { call } = h;
    h.a.upsertPrivateChannel(OTHER, { id: NEW, type: DM_CHANNEL_TYPE, recipients: [BOB] }, true);
    return Promise.all([
      expect(call('privateChannel', GROUP)).resolves.toEqual({ kind: GROUP_DM_CHANNEL_TYPE, closed: false, recipients: [CY.id, DI.id], ownerId: SELF, request: false }),
      expect(call('privateChannel', GUILD_CHANNEL)).resolves.toBeNull(),
      expect(call('privateChannel', NEW)).resolves.toBeNull(),
      expect(call('dmWith', BOB.id)).resolves.toBe(DM),
    ]);
  });

  it('a DM taken out of the archive is declined for auto-archive; archiving it again clears that', async () => {
    const { call } = h;
    await call('setOptIn', DM, false);
    expect(row(DM)).toMatchObject({ opted_in: 0, auto_declined: 1 });
    await call('setOptIn', DM, true);
    expect(row(DM)).toMatchObject({ opted_in: 1, auto_declined: 0 });
  });
});

describe('friends', () => {
  it("names friends from READY's relationships (users by id) and RELATIONSHIP_*; others aren't friends", () => {
    const tap = new EventEmitter<{ dispatch: [GatewayDispatch] }>();
    const index = new FriendIndex(tap as unknown as GatewayTap);
    const send = (t: string, d: unknown): void => void tap.emit('dispatch', { t, s: null, d });
    send('READY', {
      users: [BOB, CY],
      relationships: [
        { id: BOB.id, type: 1, user_id: BOB.id, since: '2024-03-01T00:00:00Z' },
        { id: CY.id, type: 2, user_id: CY.id },
      ],
    });
    expect(index.list()).toEqual([{ id: BOB.id, name: 'Bob', username: 'bob', avatar: 'b0b', since: Date.UTC(2024, 2, 1) }]);
    expect(index.isFriend(CY.id)).toBe(false);
    send('RELATIONSHIP_ADD', { id: DI.id, type: 1, user: DI });
    // An update without the person keeps them, and their since.
    send('RELATIONSHIP_UPDATE', { id: BOB.id, type: 1 });
    expect(index.list().map((f) => [f.name, f.since])).toEqual([['Bob', Date.UTC(2024, 2, 1)], ['di', null]]);
    send('RELATIONSHIP_REMOVE', { id: BOB.id, type: 1 });
    expect(index.isFriend(BOB.id)).toBe(false);
  });
});
