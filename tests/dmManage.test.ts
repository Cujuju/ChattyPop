// DM management requires the signed-in account’s private channel. Answers merge immediately except closes, which await gateway deletion. Read acknowledgements use Discord’s newest message.
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DM_CHANNEL_TYPE, DiscordHttpError, GROUP_DM_CHANNEL_TYPE, MUTED_FOREVER, type RawPrivateChannel } from '@shared/discord';
import { GROUP_DM_MAX_MEMBERS, GROUP_DM_NAME_MAX, MUTE_1_HOUR_S, MUTE_UNTIL_UNMUTED } from '@shared/dms';
import { MS_PER_S } from '@shared/units';
import type { GatewayDispatch, GatewayTap } from '../src/main/discord/gatewayTap';
import { BOB, CY, DI, DM, GROUP, GUILD_CHANNEL, NEW, SELF, STRANGER, dm, dmArchive, dmService, friends, group, people } from './dmFixtures';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));

const { DM_CONTEXT } = await import('../src/main/discord/dms');
const { checkAdd } = await import('../src/main/discord/dmChecks');
const { ReadStates } = await import('../src/main/discord/readStates');

const NOW = Date.UTC(2026, 9, 1);
const LAST = '500000000000000001';
let h: ReturnType<typeof dmArchive>;
beforeEach(() => {
  h = dmArchive();
});
const service = (answer?: (method: string, path: string) => unknown) => dmService(h, answer, () => NOW);
const roster = (id: string): string[] => JSON.parse((h.row(id) as { recipients: string }).recipients) as string[];
const closed = (id: string): boolean => (h.row(id) as { closed_at: number | null }).closed_at !== null;

describe('who can join a conversation', () => {
  const open = { kind: GROUP_DM_CHANNEL_TYPE, closed: false, recipients: [CY.id, DI.id], ownerId: SELF, request: false };

  it('friends not in it yet, each once, never self', () => {
    expect(checkAdd(open, [BOB.id, CY.id, BOB.id], SELF, friends)).toEqual([BOB.id]);
    expect(() => checkAdd(open, [STRANGER], SELF, friends)).toThrow('Only friends can be in a group.');
    expect(() => checkAdd(open, [CY.id], SELF, friends)).toThrow('Pick someone not in this conversation.');
    expect(() => checkAdd(open, [SELF], SELF, friends)).toThrow("You're in it already");
    expect(() => checkAdd({ ...open, closed: true }, [BOB.id], SELF, friends)).toThrow('This conversation is closed.');
    expect(() => checkAdd({ ...open, recipients: null }, [BOB.id], SELF, friends)).toThrow("members aren't known yet");
  });

  it(`up to ${GROUP_DM_MAX_MEMBERS} people with those there and the owner`, () => {
    const all = { isFriend: (): boolean => true };
    const full = { ...open, recipients: people(GROUP_DM_MAX_MEMBERS - 2) };
    expect(checkAdd(full, [BOB.id], SELF, all)).toEqual([BOB.id]);
    expect(() => checkAdd(full, [BOB.id, CY.id], SELF, all)).toThrow(`up to ${GROUP_DM_MAX_MEMBERS} people`);
  });
});

describe('adding friends', () => {
  it('to a DM: the first PUT, sent once, makes a new group; the rest join it, one PUT each', async () => {
    const made: RawPrivateChannel = { id: NEW, type: GROUP_DM_CHANNEL_TYPE, name: null, owner_id: SELF, recipients: [BOB, CY] };
    const { dms, writes } = service((_m, path) => (path.startsWith(`channels/${DM}/`) ? made : undefined));
    expect(await dms.add(DM, [CY.id, DI.id])).toEqual({ kind: 'created', channelId: NEW });
    expect(writes).toEqual([
      { method: 'PUT', path: `channels/${DM}/recipients/${CY.id}`, opts: { context: DM_CONTEXT.add, once: true } },
      { method: 'PUT', path: `channels/${NEW}/recipients/${DI.id}`, opts: { context: DM_CONTEXT.add, once: false } },
    ]);
    expect(roster(NEW)).toEqual([BOB.id, CY.id, DI.id]);
    expect(roster(DM)).toEqual([BOB.id]);
  });

  it('to a group: one PUT each (204), each person on its roster at once', async () => {
    const { dms, writes } = service();
    expect(await dms.add(GROUP, [BOB.id])).toEqual({ kind: 'opened', channelId: GROUP });
    expect(writes).toEqual([{ method: 'PUT', path: `channels/${GROUP}/recipients/${BOB.id}`, opts: { context: DM_CONTEXT.add, once: false } }]);
    expect(roster(GROUP)).toEqual([CY.id, DI.id, BOB.id]);
  });

  it('to a DM, a later PUT failing still names the group the first made; a retry there adds only the rest', async () => {
    const made: RawPrivateChannel = { id: NEW, type: GROUP_DM_CHANNEL_TYPE, name: null, owner_id: SELF, recipients: [BOB, CY] };
    const { dms } = service((_m, path) => {
      if (path.startsWith(`channels/${DM}/`)) return made;
      throw new DiscordHttpError('Discord 403: Missing Access', 403);
    });
    expect(await dms.add(DM, [CY.id, DI.id], false)).toEqual({
      kind: 'created',
      channelId: NEW,
      failed: { userIds: [DI.id], reason: 'Discord 403: Missing Access' },
    });
    // The archive choice reached the group all the same.
    expect(h.row(NEW)).toMatchObject({ opted_in: 0, auto_declined: 1 });
    const retry = service();
    expect(await retry.dms.add(NEW, [DI.id])).toEqual({ kind: 'opened', channelId: NEW });
    expect(retry.writes).toEqual([{ method: 'PUT', path: `channels/${NEW}/recipients/${DI.id}`, opts: { context: DM_CONTEXT.add, once: false } }]);
    expect(roster(NEW)).toEqual([BOB.id, CY.id, DI.id]);
  });

  it("a DM's first PUT without a clear answer is uncertain, and no one else is added", async () => {
    for (const answer of [() => undefined, () => { throw new DiscordHttpError('Discord 502', 502); }]) {
      const { dms, writes } = service(answer);
      expect(await dms.add(DM, [CY.id, DI.id])).toEqual({ kind: 'uncertain' });
      expect(writes).toHaveLength(1);
    }
  });

  it('a refusal fails with its reason and logs its path without ids', async () => {
    const { dms, notes } = service(() => {
      throw new DiscordHttpError('Discord 403: Missing Access', 403);
    });
    await expect(dms.add(GROUP, [BOB.id])).rejects.toThrow('Missing Access');
    expect(notes).toEqual([['dm-write-refused', { path: 'channels/:id/recipients/:id', status: 403 }]]);
  });
});

describe('closing and leaving', () => {
  const gateway = (t: 'CHANNEL_DELETE' | 'MESSAGE_CREATE', d: unknown): unknown => h.call('applyGatewayEvent', t, d);

  it('a DM closes with silent=false, even asked to be quiet; a group is left quietly only when asked; each sent once', async () => {
    const { dms, writes } = service();
    await dms.close(DM, true);
    await dms.close(GROUP, true);
    expect(writes).toEqual([
      { method: 'DELETE', path: `channels/${DM}?silent=false`, opts: { once: true } },
      { method: 'DELETE', path: `channels/${GROUP}?silent=true`, opts: { once: true } },
    ]);
    await gateway('CHANNEL_DELETE', { id: DM, type: DM_CHANNEL_TYPE });
    await expect(dms.close(DM, false)).rejects.toThrow('This conversation is closed.');
  });

  it("closes on the gateway's CHANNEL_DELETE alone: an answer landing after a newer reopen leaves it open", async () => {
    const { dms } = service(() => {
      void gateway('CHANNEL_DELETE', { id: DM, type: DM_CHANNEL_TYPE });
      expect(closed(DM)).toBe(true);
      // A message reopens it before Discord's answer to the close arrives.
      void gateway('MESSAGE_CREATE', { id: LAST, channel_id: DM, author: BOB, content: 'still here', timestamp: new Date(NOW).toISOString() });
      return { id: DM, type: DM_CHANNEL_TYPE };
    });
    await dms.close(DM, false);
    expect(closed(DM)).toBe(false);
  });

  it('a group left aloud sends silent=false', async () => {
    const { dms, writes } = service();
    await dms.close(GROUP, false);
    expect(writes[0]!.path).toBe(`channels/${GROUP}?silent=false`);
  });
});

describe('renaming', () => {
  it('a group only, trimmed, within the limit; the answer is stored', async () => {
    const { dms, writes } = service((): RawPrivateChannel => ({ id: GROUP, type: GROUP_DM_CHANNEL_TYPE, name: 'plans' }));
    await dms.rename(GROUP, '  plans ');
    expect(writes).toEqual([{ method: 'PATCH', path: `channels/${GROUP}`, body: { name: 'plans' } }]);
    expect(h.row(GROUP)).toMatchObject({ name: 'plans' });
    await expect(dms.rename(DM, 'x')).rejects.toThrow('Only a group can be renamed.');
    await expect(dms.rename(GROUP, '  ')).rejects.toThrow('Name the group.');
    await expect(dms.rename(GROUP, 'x'.repeat(GROUP_DM_NAME_MAX + 1))).rejects.toThrow(`at most ${GROUP_DM_NAME_MAX}`);
    expect(writes).toHaveLength(1);
  });
});

describe('muting', () => {
  const override = (w: { body?: unknown }) => (w.body as { channel_overrides: Record<string, unknown> }).channel_overrides[DM];

  it("sends the client's window and end; until unmuted has no end; unmute clears it; the answer reaches the read states", async () => {
    const answer = { guild_id: null, channel_overrides: [] };
    const { dms, writes, settings } = service(() => answer);
    await dms.mute(DM, MUTE_1_HOUR_S);
    await dms.mute(DM, MUTE_UNTIL_UNMUTED);
    await dms.mute(DM, null);
    expect(writes.map((w) => w.path)).toEqual(Array(3).fill('users/@me/guilds/@me/settings'));
    expect(writes.map(override)).toEqual([
      { muted: true, mute_config: { selected_time_window: MUTE_1_HOUR_S, end_time: new Date(NOW + MUTE_1_HOUR_S * MS_PER_S).toISOString() } },
      { muted: true, mute_config: { selected_time_window: MUTE_UNTIL_UNMUTED, end_time: null } },
      { muted: false },
    ]);
    expect(settings).toEqual([answer, answer, answer]);
  });

  it('only for one of the client\'s lengths', async () => {
    const { dms, writes } = service();
    await expect(dms.mute(DM, 1234)).rejects.toThrow('Not a mute length.');
    expect(writes).toEqual([]);
  });

  it("settings Discord answers with set the DM's mute, as the gateway's update would", () => {
    const tap = new EventEmitter<{ dispatch: [GatewayDispatch] }>();
    const counts: unknown[] = [];
    const rs = new ReadStates(tap as unknown as GatewayTap, { post: async () => undefined } as never, (c) => void counts.push(...c), () => undefined);
    tap.emit('dispatch', { t: 'READY', s: null, d: { user: { id: SELF }, private_channels: [{ id: DM }] } });
    counts.length = 0;
    rs.settingsChanged({ guild_id: null, channel_overrides: [{ channel_id: DM, muted: true, mute_config: { end_time: null } }] });
    expect(counts).toContainEqual(expect.objectContaining({ channelId: DM, muteEndsMs: MUTED_FOREVER }));
  });
});

describe('a message request is read-only', () => {
  it('close, mute, rename and add refuse it before sending', async () => {
    h.a.upsertPrivateChannel(SELF, { ...group, is_message_request: true }, true);
    const { dms, writes } = service();
    const refused = 'A message request is read-only here';
    await expect(dms.add(GROUP, [BOB.id])).rejects.toThrow(refused);
    await expect(dms.close(GROUP, false)).rejects.toThrow(refused);
    await expect(dms.rename(GROUP, 'x')).rejects.toThrow(refused);
    await expect(dms.mute(GROUP, null)).rejects.toThrow(refused);
    expect(writes).toEqual([]);
  });
});

describe('a server channel is no DM', () => {
  it('every write refuses it before sending', async () => {
    const { dms, writes } = service();
    const refused = 'Not a direct message of the account signed in.';
    await expect(dms.add(GUILD_CHANNEL, [BOB.id])).rejects.toThrow(refused);
    await expect(dms.close(GUILD_CHANNEL, false)).rejects.toThrow(refused);
    await expect(dms.rename(GUILD_CHANNEL, 'x')).rejects.toThrow(refused);
    await expect(dms.mute(GUILD_CHANNEL, null)).rejects.toThrow(refused);
    await expect(h.call('markDmRead', GUILD_CHANNEL)).rejects.toThrow(refused);
    expect(writes).toEqual([]);
  });
});

describe('mark read', () => {
  it("acks Discord's newest message in the DM, stored or not", async () => {
    h.a.upsertPrivateChannel(SELF, { ...dm, last_message_id: LAST }, true);
    await h.call('markDmRead', DM);
    expect(h.events).toContainEqual({ type: 'channel-read', channelId: DM, messageId: LAST });
  });
});
