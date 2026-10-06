import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppEvent, ReadStateCount, ReadStateScope } from '@shared/contract';
import { MS_PER_MIN } from '@shared/units';
import type { Db } from '../src/core/db';
import type { Archive } from '../src/core/archive';
import { ARRIVAL } from '../src/core/arrival';
import { archiveHandlers } from '../src/core/archiveHandlers';
import { newestMessageId } from '../src/core/queries/readMarks';
import { putReadStates } from '../src/core/queries/readStates';
import { directory } from '../src/core/queries/directory';
import type { GatewayDispatch, GatewayTap } from '../src/main/discord/gatewayTap';
import { ReadStates, type PingMessage } from '../src/main/discord/readStates';
import { rawMessage, seedArchive, tempDb } from './helpers';

const ME = '900000000000000001';
const GUILD = '100000000000000001';
const GENERAL = '200000000000000001';
const DM = '300000000000000001';
const MY_ROLE = '400000000000000001';
const OTHER_ROLE = '400000000000000002';
const NOW = Date.UTC(2026, 8, 30);

/** Increasing snowflake IDs represent newer messages. */
const id = (n: number): string => String(500000000000000000n + BigInt(n));

function setup() {
  const tap = new EventEmitter<{ dispatch: [GatewayDispatch] }>();
  const posts: { path: string; json: unknown }[] = [];
  let fail = false;
  /** While set, posts wait on it: an ack in flight. */
  let held: Promise<void> | null = null;
  const api = {
    post: async (path: string, json: unknown, opts?: { guard?: () => void }) => {
      await held;
      opts?.guard?.();
      posts.push({ path, json });
      if (fail) throw new Error('Discord said no');
    },
  };
  const counts = new Map<string, number>();
  const projected = new Map<string, ReadStateCount>();
  const errors: string[] = [];
  const states = new ReadStates(
    tap as unknown as GatewayTap,
    api as never,
    (changed: ReadStateCount[], scope: ReadStateScope) => {
      if (scope !== 'merge') counts.clear();
      if (scope !== 'merge') projected.clear();
      // An absent count keeps the stored one, as core does.
      for (const c of changed) {
        projected.set(c.channelId, c);
        if (c.mentionCount !== undefined) counts.set(c.channelId, c.mentionCount);
      }
    },
    (event, data) => void (event === 'read-state-ack-failed' && errors.push(String(data['message']))),
    () => NOW,
  );
  const send = (t: string, d: unknown): void => void tap.emit('dispatch', { t, s: null, d });
  const ready = (o: { readState?: unknown; settings?: unknown[]; roles?: string[] } = {}): void =>
    send('READY', {
      user: { id: ME },
      guilds: [{ id: GUILD }],
      merged_members: [[{ user_id: ME, roles: o.roles ?? [MY_ROLE] }]],
      user_guild_settings: { entries: o.settings ?? [], partial: false, version: 1 },
      read_state: o.readState ?? { entries: [{ id: GENERAL, last_message_id: id(10), mention_count: 0 }], partial: false, version: 1 },
    });
  const message = (n: number, m: Partial<PingMessage> = {}): void =>
    send('MESSAGE_CREATE', { id: id(n), channel_id: GENERAL, guild_id: GUILD, type: 0, author: { id: 'u1' }, mentions: [], mention_roles: [], mention_everyone: false, ...m });
  const dm = (n: number, m: Partial<PingMessage> = {}): void => message(n, { channel_id: DM, guild_id: undefined, ...m });
  const hold = (): (() => void) => {
    let release!: () => void;
    held = new Promise((r) => (release = r));
    return () => {
      held = null;
      release();
    };
  };
  return { states, send, ready, message, dm, counts, projected, posts, errors, hold, failPosts: () => void (fail = true) };
}

describe("Discord's read states: the sidebar's mention count", () => {
  it("starts from READY's read states; other read state types aren't channels", () => {
    const s = setup();
    s.ready({ readState: { entries: [{ id: GENERAL, last_message_id: id(1), mention_count: 4 }, { id: GUILD, read_state_type: 1, mention_count: 9 }], partial: false } });
    expect([...s.counts]).toEqual([[GENERAL, 4]]);
  });

  it('reads a bare read state list too', () => {
    const s = setup();
    s.ready({ readState: [{ id: GENERAL, last_message_id: id(1), mention_count: 2 }] });
    expect(s.counts.get(GENERAL)).toBe(2);
  });

  it("counts a new message that names the owner, one of the owner's roles, or @everyone / @here", () => {
    const s = setup();
    s.ready();
    s.message(11, { mentions: [{ id: ME }] });
    s.message(12, { mention_roles: [MY_ROLE] });
    s.message(13, { mention_everyone: true });
    s.message(14, { mention_roles: [OTHER_ROLE] });
    s.message(15, { mentions: [{ id: 'u2' }] });
    expect(s.counts.get(GENERAL)).toBe(3);
  });

  it("leaves out role and everyone pings the owner's server settings suppress", () => {
    const s = setup();
    s.ready({ settings: [{ guild_id: GUILD, suppress_roles: true, suppress_everyone: true }] });
    s.message(11, { mention_roles: [MY_ROLE] });
    s.message(12, { mention_everyone: true });
    s.message(13, { mentions: [{ id: ME }] });
    expect(s.counts.get(GENERAL)).toBe(1);
  });

  it('follows the owner gaining a role', () => {
    const s = setup();
    s.ready({ roles: [] });
    s.message(11, { mention_roles: [MY_ROLE] });
    s.send('GUILD_MEMBER_UPDATE', { guild_id: GUILD, user: { id: ME }, roles: [MY_ROLE] });
    s.message(12, { mention_roles: [MY_ROLE] });
    expect(s.counts.get(GENERAL)).toBe(1);
  });

  it('counts every message in an unmuted DM; a muted one only when it names the owner, until the mute ends', () => {
    const s = setup();
    s.ready();
    s.dm(11);
    s.dm(12, { type: 2 }); // a member removed
    expect(s.counts.get(DM)).toBe(1);
    const mute = (end: string | null) => s.send('USER_GUILD_SETTINGS_UPDATE', { guild_id: null, channel_overrides: [{ channel_id: DM, muted: true, mute_config: { end_time: end } }] });
    mute(null);
    s.dm(13);
    s.dm(14, { mentions: [{ id: ME }] });
    expect(s.counts.get(DM)).toBe(2);
    mute(new Date(NOW - MS_PER_MIN).toISOString());
    s.dm(15);
    expect(s.counts.get(DM)).toBe(3);
  });

  it("clears on a read anywhere (MESSAGE_ACK), or the owner's own message", () => {
    const s = setup();
    s.ready();
    s.message(11, { mentions: [{ id: ME }] });
    s.send('MESSAGE_ACK', { channel_id: GENERAL, message_id: id(11), version: 2 });
    expect(s.counts.get(GENERAL)).toBe(0);
    s.message(12, { mentions: [{ id: ME }] });
    s.message(13, { author: { id: ME } });
    expect(s.counts.get(GENERAL)).toBe(0);
  });

  it('takes the count a read carries (marked unread from a message)', () => {
    const s = setup();
    s.ready();
    s.send('MESSAGE_ACK', { channel_id: GENERAL, message_id: id(5), mention_count: 2, manual: true });
    expect(s.counts.get(GENERAL)).toBe(2);
  });

  it('an external read without a count keeps pings newer than the acknowledged message', () => {
    const s = setup();
    s.ready();
    s.message(11, { mentions: [{ id: ME }] });
    s.message(12, { mentions: [{ id: ME }] });
    s.send('MESSAGE_ACK', { channel_id: GENERAL, message_id: id(11) });
    expect(s.projected.get(GENERAL)).toMatchObject({ ackId: id(11), mentionCount: 1 });
  });

  it('an omitted or null acknowledgment count retains mentions whose messages are unknown', () => {
    const s = setup();
    s.ready({ readState: [{ id: GENERAL, last_message_id: id(10), mention_count: 2 }] });
    s.send('MESSAGE_ACK', { channel_id: GENERAL, message_id: id(11) });
    expect(s.counts.get(GENERAL)).toBe(2);
    s.send('MESSAGE_ACK', { channel_id: GENERAL, message_id: id(12), mention_count: null });
    expect(s.counts.get(GENERAL)).toBe(2);
    s.send('MESSAGE_ACK', { channel_id: GENERAL, message_id: id(13), mention_count: 0 });
    expect(s.counts.get(GENERAL)).toBe(0);
  });

  it('ignores acknowledgments of non-channel read states', () => {
    const s = setup();
    s.ready();
    s.message(11, { mentions: [{ id: ME }] });
    s.send('MESSAGE_ACK', { channel_id: GENERAL, message_id: id(11), ack_type: 5, mention_count: 0 });
    expect(s.projected.get(GENERAL)).toMatchObject({ ackId: id(10), mentionCount: 1 });
  });

  it('an external read count includes its retained pings exactly once', () => {
    const s = setup();
    s.ready();
    s.message(11, { mentions: [{ id: ME }] });
    s.message(12, { mentions: [{ id: ME }] });
    s.message(13, { mentions: [{ id: ME }] });
    s.send('MESSAGE_ACK', { channel_id: GENERAL, message_id: id(11), mention_count: 2 });
    expect(s.counts.get(GENERAL)).toBe(2);
    s.states.ack(GENERAL, id(12));
    expect(s.counts.get(GENERAL)).toBe(1);
  });

  it('a delayed ordinary read cannot undo a newer read, while a manual unread can', () => {
    const s = setup();
    s.ready();
    s.send('MESSAGE_ACK', { channel_id: GENERAL, message_id: id(13) });
    s.send('MESSAGE_ACK', { channel_id: GENERAL, message_id: id(11) });
    expect(s.projected.get(GENERAL)).toMatchObject({ ackId: id(13), mentionCount: 0 });
    s.send('MESSAGE_ACK', { channel_id: GENERAL, message_id: id(11), mention_count: 2, manual: true });
    expect(s.projected.get(GENERAL)).toMatchObject({ ackId: id(11), mentionCount: 2 });
  });

  it('ignores a message older than the last read (one a sync delivers late)', () => {
    const s = setup();
    s.ready();
    s.message(9, { mentions: [{ id: ME }] });
    expect(s.counts.get(GENERAL)).toBe(0);
  });
});

describe("Discord's read states: reading a channel in ChattyPop", () => {
  it('acknowledges it on Discord once, as its client does, and clears the count', async () => {
    const s = setup();
    s.ready();
    s.message(11, { mentions: [{ id: ME }] });
    s.states.ack(GENERAL, id(11));
    s.states.ack(GENERAL, id(11));
    s.states.ack(GENERAL, id(10));
    await new Promise((r) => setTimeout(r));
    expect(s.posts).toEqual([{ path: `channels/${GENERAL}/messages/${id(11)}/ack`, json: { token: null } }]);
    expect(s.counts.get(GENERAL)).toBe(0);
  });

  it('puts the count back when Discord refuses the read', async () => {
    const s = setup();
    s.ready();
    s.message(11, { mentions: [{ id: ME }] });
    s.failPosts();
    s.states.ack(GENERAL, id(11));
    await new Promise((r) => setTimeout(r));
    expect(s.counts.get(GENERAL)).toBe(1);
    expect(s.errors).toEqual(['Discord said no']);
  });

  const settle = () => new Promise((r) => setTimeout(r));

  it('a read up to a message keeps counting the pings after it', () => {
    const s = setup();
    s.ready();
    s.message(11, { mentions: [{ id: ME }] });
    s.message(12, { mentions: [{ id: ME }] });
    s.states.ack(GENERAL, id(11));
    expect(s.counts.get(GENERAL)).toBe(1);
  });

  it('a refused read puts back its count with the pings that came while it was sending', async () => {
    const s = setup();
    s.ready();
    s.message(11, { mentions: [{ id: ME }] });
    const release = s.hold();
    s.failPosts();
    s.states.ack(GENERAL, id(11));
    s.message(12, { mentions: [{ id: ME }] });
    expect(s.counts.get(GENERAL)).toBe(1);
    release();
    await settle();
    expect(s.counts.get(GENERAL)).toBe(2);
    // Back where it was, the same read can go again.
    s.states.ack(GENERAL, id(11));
    await settle();
    expect(s.posts).toHaveLength(2);
  });

  it('sends one read per channel at a time; newer reads meanwhile go as one, the newest', async () => {
    const s = setup();
    s.ready();
    const release = s.hold();
    s.states.ack(GENERAL, id(11));
    s.states.ack(GENERAL, id(12));
    s.states.ack(GENERAL, id(13));
    release();
    await settle();
    await settle();
    expect(s.posts.map((p) => p.path)).toEqual([`channels/${GENERAL}/messages/${id(11)}/ack`, `channels/${GENERAL}/messages/${id(13)}/ack`]);
  });

  it('an older ack echo keeps the queued read and restores the confirmed state if the queued read fails', async () => {
    const s = setup();
    s.ready();
    s.message(11, { mentions: [{ id: ME }] });
    s.message(12, { mentions: [{ id: ME }] });
    const release = s.hold();
    s.states.ack(GENERAL, id(11));
    s.states.ack(GENERAL, id(12));
    s.message(13, { mentions: [{ id: ME }] });
    s.send('MESSAGE_ACK', { channel_id: GENERAL, message_id: id(11), mention_count: 2 });
    expect(s.projected.get(GENERAL)).toMatchObject({ ackId: id(12), mentionCount: 1 });
    s.failPosts();
    release();
    await settle();
    await settle();
    expect(s.projected.get(GENERAL)).toMatchObject({ ackId: id(11), mentionCount: 2 });
  });

  it('never sends a read once another account has signed in', async () => {
    const s = setup();
    s.ready();
    const release = s.hold();
    s.states.ack(GENERAL, id(11));
    s.send('READY', { user: { id: '900000000000000002' }, read_state: { entries: [], partial: false } });
    release();
    await settle();
    expect(s.posts).toEqual([]);
  });
});

describe("Discord's read states: the stored counts", () => {
  let db: Db;
  let archive: Archive;
  beforeEach(() => {
    db = tempDb();
    archive = seedArchive(db, [{ id: GENERAL }], { guilds: [{ id: GUILD, name: 'Guild' }] });
  });
  const mentionCount = (): number => directory(db, 0).flatMap((g) => g.channels).find((c) => c.id === GENERAL)!.mentionCount;

  it("the sidebar shows the stored count; READY replaces every channel's", () => {
    expect(mentionCount()).toBe(0);
    putReadStates(db, [{ channelId: GENERAL, mentionCount: 3 }], 'merge');
    expect(mentionCount()).toBe(3);
    putReadStates(db, [], 'replace');
    expect(mentionCount()).toBe(0);
  });

  it('reading a channel in the Archive asks main to acknowledge the message shown, once, never going back', () => {
    const events: AppEvent[] = [];
    const handlers = archiveHandlers({
      ready: () => ({ db, archive }),
      emit: (e) => events.push(e),
      noteChanged: () => {},
      backfillFromMs: () => 0,
      selfId: () => ME,
      lastSeenAt: () => 0,
      applyTextTier: async () => {},
      autoArchiveSinceMs: () => null,
    });
    handlers.markChannelRead(GENERAL, '999');
    expect(events).toEqual([]);
    const older = rawMessage(GENERAL, NOW - 2 * MS_PER_MIN, 'a');
    const m = rawMessage(GENERAL, NOW - MS_PER_MIN, 'b');
    archive.ingestMessages([older, m], ARRIVAL.gateway);
    handlers.markChannelRead(GENERAL, m.id);
    handlers.markChannelRead(GENERAL, older.id);
    handlers.markChannelRead(GENERAL, m.id);
    expect(events).toEqual([{ type: 'channel-read', channelId: GENERAL, messageId: m.id }]);
  });
  it('a read acknowledges the newest message', () => {
    const newer = rawMessage(GENERAL, NOW - MS_PER_MIN, 'b');
    archive.ingestMessages([rawMessage(GENERAL, NOW - 2 * MS_PER_MIN, 'a'), newer], ARRIVAL.gateway);
    expect(newestMessageId(db, GENERAL)).toBe(newer.id);
  });
});
