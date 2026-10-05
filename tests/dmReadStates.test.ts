// Contract (docs/dms.md §3.3): main's read states project each DM's last read message and mute end to core (null: not
// muted; MUTED_FOREVER: until unmuted), re-sent on READY, MESSAGE_ACK, USER_GUILD_SETTINGS_UPDATE and CHANNEL_CREATE.
// Server channels carry their mention count only. A field main doesn't know is left out; core keeps a field a count
// leaves out, and drops a row with nothing to say. A partial READY merges; a READY for another account starts over.
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { ReadStateCount, ReadStateScope } from '@shared/contract';
import { MUTED_FOREVER } from '@shared/discord';
import { putReadStates } from '../src/core/queries/readStates';
import type { GatewayDispatch, GatewayTap } from '../src/main/discord/gatewayTap';
import { ReadStates } from '../src/main/discord/readStates';
import { tempDb } from './helpers';

const ME = '900000000000000001';
const GUILD = '100000000000000001';
const GENERAL = '200000000000000001';
const DM = '300000000000000001';
const MUTED_DM = '300000000000000002';
const NOW = Date.UTC(2026, 8, 30);
const MUTE_END = '2026-10-01T00:00:00.000Z';
const id = (n: number): string => String(500000000000000000n + BigInt(n));

function setup() {
  const tap = new EventEmitter<{ dispatch: [GatewayDispatch] }>();
  const sent: { counts: ReadStateCount[]; scope: ReadStateScope }[] = [];
  new ReadStates(tap as unknown as GatewayTap, { post: async () => undefined } as never, (counts, scope) => void sent.push({ counts, scope }), () => undefined, () => NOW);
  const send = (t: string, d: unknown): void => void tap.emit('dispatch', { t, s: null, d });
  const last = (channelId: string): ReadStateCount | undefined => sent.flatMap((s) => s.counts).findLast((c) => c.channelId === channelId);
  return { send, sent, last };
}

const ready = (dmOverrides: unknown[]) => ({
  user: { id: ME },
  guilds: [{ id: GUILD }],
  private_channels: [{ id: DM, type: 1 }, { id: MUTED_DM, type: 3 }],
  user_guild_settings: { entries: [{ guild_id: null, channel_overrides: dmOverrides }], partial: false },
  read_state: { entries: [{ id: DM, last_message_id: id(4), mention_count: 2 }, { id: GENERAL, last_message_id: id(9), mention_count: 1 }], partial: false },
});

describe("main's DM read and mute projection", () => {
  it("READY sends every channel's count and last read message, and a DM's mute end", () => {
    const s = setup();
    s.send('READY', ready([{ channel_id: MUTED_DM, muted: true, mute_config: { end_time: null } }]));
    expect(s.sent.at(-1)?.scope).toBe('replace');
    expect(s.last(DM)).toEqual({ channelId: DM, mentionCount: 2, ackId: id(4), muteEndsMs: null });
    // No read state for it: its count and last read stay unknown, so core keeps what it has.
    expect(s.last(MUTED_DM)).toEqual({ channelId: MUTED_DM, muteEndsMs: MUTED_FOREVER });
    expect(s.last(GENERAL)).toEqual({ channelId: GENERAL, mentionCount: 1, ackId: id(9) });
  });

  it("the owner's message reads the channel up to it; a late or replayed older one moves nothing back", () => {
    const s = setup();
    s.send('READY', ready([]));
    const own = (n: number): void => s.send('MESSAGE_CREATE', { id: id(n), channel_id: GENERAL, guild_id: GUILD, type: 0, author: { id: ME } });
    own(12);
    expect(s.last(GENERAL)).toMatchObject({ mentionCount: 0, ackId: id(12) });
    own(10);
    expect(s.last(GENERAL)?.ackId).toBe(id(12));
  });

  it('a timed mute sends when it ends; the renderer compares it with the clock', () => {
    const s = setup();
    s.send('READY', ready([{ channel_id: DM, muted: true, mute_config: { end_time: MUTE_END } }]));
    expect(s.last(DM)?.muteEndsMs).toBe(Date.parse(MUTE_END));
  });

  it('USER_GUILD_SETTINGS_UPDATE for DMs re-sends every DM: a dropped override unmutes', () => {
    const s = setup();
    s.send('READY', ready([{ channel_id: MUTED_DM, muted: true }]));
    s.send('USER_GUILD_SETTINGS_UPDATE', { guild_id: null, channel_overrides: [{ channel_id: DM, muted: true }] });
    expect(s.last(DM)?.muteEndsMs).toBe(MUTED_FOREVER);
    expect(s.last(MUTED_DM)?.muteEndsMs).toBeNull();
    const before = s.sent.length;
    s.send('USER_GUILD_SETTINGS_UPDATE', { guild_id: GUILD, muted: true });
    expect(s.sent.length).toBe(before);
  });

  it("MESSAGE_ACK sends a DM's new last read message, with its mute", () => {
    const s = setup();
    s.send('READY', ready([{ channel_id: DM, muted: true }]));
    s.send('MESSAGE_ACK', { channel_id: DM, message_id: id(7) });
    expect(s.last(DM)).toEqual({ channelId: DM, mentionCount: 0, ackId: id(7), muteEndsMs: MUTED_FOREVER });
  });

  it('a DM with no known read state leaves its last read out, even after a message counts there', () => {
    const s = setup();
    s.send('READY', ready([]));
    s.send('MESSAGE_CREATE', { id: id(8), channel_id: MUTED_DM, type: 0, author: { id: '1' } });
    expect(s.last(MUTED_DM)).toEqual({ channelId: MUTED_DM, mentionCount: 1, muteEndsMs: null });
  });

  it('a partial READY merges: read states and DM overrides it leaves out keep their cached values', () => {
    const s = setup();
    s.send('READY', ready([{ channel_id: MUTED_DM, muted: true }]));
    s.send('READY', {
      ...ready([]),
      user_guild_settings: { entries: [{ guild_id: GUILD }], partial: true },
      read_state: { entries: [{ id: GENERAL, last_message_id: id(10), mention_count: 0 }], partial: true },
    });
    expect(s.sent.at(-1)?.scope).toBe('merge');
    expect(s.last(MUTED_DM)?.muteEndsMs).toBe(MUTED_FOREVER);
    expect(s.last(DM)).toMatchObject({ mentionCount: 2, ackId: id(4) });
  });

  it("a READY for another account drops the last one's acks, counts and mutes, and core's stored ones", () => {
    const s = setup();
    s.send('READY', ready([{ channel_id: MUTED_DM, muted: true }]));
    s.send('READY', {
      user: { id: '900000000000000002' },
      private_channels: { entries: [{ id: DM, type: 1 }], partial: true },
      user_guild_settings: { entries: [], partial: true },
      read_state: { entries: [], partial: true },
    });
    const sent = s.sent.at(-1)!;
    expect(sent.scope).toBe('reset');
    expect(sent.counts).toEqual([{ channelId: DM }]);
  });

  it('CHANNEL_CREATE for a DM READY did not list sends its cached last read and mute', () => {
    const s = setup();
    const closed = '300000000000000005';
    s.send('READY', { ...ready([{ channel_id: closed, muted: true }]), read_state: { entries: [{ id: closed, last_message_id: id(3), mention_count: 0 }], partial: false } });
    s.send('CHANNEL_CREATE', { id: closed, type: 1 });
    expect(s.last(closed)).toEqual({ channelId: closed, mentionCount: 0, ackId: id(3), muteEndsMs: MUTED_FOREVER });
  });

  it('a READY that leaves its read_state out is partial: it replaces nothing', () => {
    const s = setup();
    s.send('READY', { ...ready([]), read_state: undefined });
    expect(s.sent.at(-1)?.scope).toBe('merge');
  });

  it('a DM made after READY (CHANNEL_CREATE, or a message with no server) is a DM from then on', () => {
    const s = setup();
    s.send('READY', ready([]));
    const fresh = '300000000000000003';
    s.send('CHANNEL_CREATE', { id: fresh, type: 1 });
    s.send('MESSAGE_ACK', { channel_id: fresh, message_id: id(1) });
    expect(s.last(fresh)).toMatchObject({ ackId: id(1), muteEndsMs: null });
    const other = '300000000000000004';
    s.send('MESSAGE_CREATE', { id: id(2), channel_id: other, type: 0, author: { id: ME } });
    expect(s.last(other)).toMatchObject({ ackId: id(2) });
  });
});

describe("core's read states", () => {
  const rows = (db: ReturnType<typeof tempDb>) => db.prepare('SELECT channel_id AS id, mention_count AS m, ack_id AS ack, mute_ends_ms AS mute FROM read_states ORDER BY channel_id').all();

  it('keeps a DM field a count leaves out, clears one sent as null, and drops an empty row', () => {
    const db = tempDb();
    putReadStates(db, [{ channelId: DM, mentionCount: 0, ackId: id(1), muteEndsMs: MUTED_FOREVER }, { channelId: GENERAL, mentionCount: 3 }], 'reset');
    expect(rows(db)).toEqual([
      { id: GENERAL, m: 3, ack: null, mute: null },
      { id: DM, m: 0, ack: id(1), mute: MUTED_FOREVER },
    ]);
    putReadStates(db, [{ channelId: DM, mentionCount: 1 }], 'merge');
    expect(rows(db)).toContainEqual({ id: DM, m: 1, ack: id(1), mute: MUTED_FOREVER });
    putReadStates(db, [{ channelId: DM, muteEndsMs: null }], 'merge');
    expect(rows(db)).toContainEqual({ id: DM, m: 1, ack: id(1), mute: null });
    putReadStates(db, [{ channelId: DM, mentionCount: 0, ackId: null, muteEndsMs: null }, { channelId: GENERAL, mentionCount: 0 }], 'merge');
    expect(rows(db)).toEqual([]);
  });

  it("READY's replace keeps a listed DM's mute it doesn't know and drops what it doesn't list; a reset forgets both", () => {
    const db = tempDb();
    putReadStates(db, [{ channelId: DM, mentionCount: 1, ackId: id(1), muteEndsMs: MUTED_FOREVER }, { channelId: GENERAL, mentionCount: 3 }], 'merge');
    putReadStates(db, [{ channelId: DM, mentionCount: 0, ackId: id(2) }], 'replace');
    expect(rows(db)).toEqual([{ id: DM, m: 0, ack: id(2), mute: MUTED_FOREVER }]);
    putReadStates(db, [{ channelId: DM, mentionCount: 0, ackId: id(2) }], 'reset');
    expect(rows(db)).toEqual([{ id: DM, m: 0, ack: id(2), mute: null }]);
  });

  it('a READY entry that leaves a field out keeps the cached one', () => {
    const s = setup();
    s.send('READY', ready([]));
    s.send('READY', { ...ready([]), read_state: { entries: [{ id: DM, mention_count: 1 }], partial: false } });
    expect(s.last(DM)).toMatchObject({ mentionCount: 1, ackId: id(4) });
  });
});
