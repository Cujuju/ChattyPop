import { beforeEach, describe, expect, it } from 'vitest';
import { MS_PER_MIN } from '@shared/units';
import type { Db } from '../src/core/db';
import type { Archive } from '../src/core/archive';
import { lastReader, markRead, messageRead, recordReader, unreadMark } from '../src/core/queries/readMarks';
import { putReadStates } from '../src/core/queries/readStates';
import { directory } from '../src/core/queries/directory';
import { ARRIVAL } from '../src/core/arrival';
import { firstUnreadAbove, messageToMark } from '../src/renderer/src/state/lastReadRules';
import { rawMessage, seedArchive, tempDb } from './helpers';

const GUILD = '100000000000000001';
const GENERAL = '200000000000000001';
const OTHER = '200000000000000002';
const T0 = Date.UTC(2026, 8, 1);
/** The end of the previous app session: the mark of a channel never opened. */
const LAST_SEEN = T0 + 2 * MS_PER_MIN;
/** The signed-in account; rawMessage's default author is someone else. */
const SELF = 'u-self';

let db: Db;
let archive: Archive;
beforeEach(() => {
  db = tempDb();
  archive = seedArchive(db, [{ id: GENERAL }, { id: OTHER }], { guilds: [{ id: GUILD, name: 'Guild' }] });
});

const post = (minute: number, channelId = GENERAL, authorId?: string) => {
  const m = rawMessage(channelId, T0 + minute * MS_PER_MIN, `at ${minute}`, authorId ? { author: { id: authorId, username: authorId, global_name: null } } : {});
  archive.ingestMessages([m], ARRIVAL.gateway);
  return m;
};
const newCount = (channelId: string): number | undefined => directory(db, LAST_SEEN, SELF).flatMap((g) => g.channels).find((c) => c.id === channelId)?.newCount;

describe('last read: which messages are unread', () => {
  it('counts from the end of the last session while a channel was never opened, first unread the oldest after it', () => {
    post(1);
    const first = post(3);
    post(4);
    post(5, OTHER);
    expect(unreadMark(db, GENERAL, LAST_SEEN, SELF)).toEqual({ channelId: GENERAL, count: 2, firstId: first.id, firstTs: T0 + 3 * MS_PER_MIN });
  });

  it('matches the sidebar new count', () => {
    post(3);
    post(4);
    expect(unreadMark(db, GENERAL, LAST_SEEN, SELF)?.count).toBe(newCount(GENERAL));
  });

  it('marking up to a message reads it and everything before it, then only newer messages count', () => {
    post(3);
    const seen = post(4);
    expect(markRead(db, GENERAL, seen.id)).toBe(true);
    expect(unreadMark(db, GENERAL, LAST_SEEN, SELF)).toBeNull();
    expect(newCount(GENERAL)).toBe(0);
    const later = post(12);
    expect(unreadMark(db, GENERAL, LAST_SEEN, SELF)).toMatchObject({ count: 1, firstId: later.id });
  });

  it('never moves back, and takes only a message of the channel', () => {
    const older = post(3);
    const newer = post(4);
    expect(markRead(db, GENERAL, newer.id)).toBe(true);
    expect(markRead(db, GENERAL, older.id)).toBe(false);
    expect(markRead(db, GENERAL, newer.id)).toBe(false);
    const elsewhere = post(5, OTHER);
    expect(markRead(db, GENERAL, elsewhere.id)).toBe(false);
    expect(markRead(db, GENERAL, 'missing')).toBe(false);
  });

  it('orders by message, not the clock: a tie on time splits by id, a later message counts whatever its time', () => {
    const at = T0 + 3 * MS_PER_MIN;
    const a = rawMessage(GENERAL, at, 'a');
    const b = { ...rawMessage(GENERAL, at, 'b'), id: (BigInt(a.id) + 1n).toString() };
    archive.ingestMessages([a, b], ARRIVAL.gateway);
    markRead(db, GENERAL, a.id);
    expect(unreadMark(db, GENERAL, LAST_SEEN, SELF)).toMatchObject({ count: 1, firstId: b.id });
  });

  it("never counts the owner's own messages, in the banner or the sidebar", () => {
    post(3, GENERAL, SELF);
    expect(unreadMark(db, GENERAL, LAST_SEEN, SELF)).toBeNull();
    expect(newCount(GENERAL)).toBe(0);
    const theirs = post(4);
    post(5, GENERAL, SELF);
    expect(unreadMark(db, GENERAL, LAST_SEEN, SELF)).toMatchObject({ count: 1, firstId: theirs.id });
    expect(newCount(GENERAL)).toBe(1);
  });

  it("never counts a bot's messages (an embed fixer reposting a link), in the banner or the sidebar", () => {
    const link = post(3);
    archive.ingestMessages([rawMessage(GENERAL, T0 + 3 * MS_PER_MIN + 1, 'fixed embed', { author: { id: 'u-bot', username: 'fixer', global_name: null, bot: true } })], ARRIVAL.gateway);
    expect(unreadMark(db, GENERAL, LAST_SEEN, SELF)).toMatchObject({ count: 1, firstId: link.id });
    expect(unreadMark(db, GENERAL, LAST_SEEN, SELF, link.id)?.count).toBe(1);
    expect(newCount(GENERAL)).toBe(1);
  });

  it('moves one channel only', () => {
    const seen = post(3);
    post(4, OTHER);
    markRead(db, GENERAL, seen.id);
    expect(unreadMark(db, OTHER, LAST_SEEN, SELF)?.count).toBe(1);
  });

  it('counts in the sidebar only what the banner counts while privacy mode hides a message', () => {
    post(3);
    archive.ingestMessages([rawMessage(GENERAL, T0 + 4 * MS_PER_MIN, `see <#${OTHER}>`)], ARRIVAL.gateway);
    expect(newCount(GENERAL)).toBe(2);
    db.prepare('UPDATE channels SET hide_in_privacy = 1 WHERE id = ?').run(OTHER);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('privacyMode', 'true')").run();
    expect(unreadMark(db, GENERAL, LAST_SEEN, SELF)?.count).toBe(1);
    expect(newCount(GENERAL)).toBe(1);
  });

  it('a mark kept as a time (before marks named a message) still counts from it, and moves on to a message', () => {
    post(1);
    db.prepare('UPDATE channels SET viewed_at = ? WHERE id = ?').run(T0, GENERAL);
    expect(unreadMark(db, GENERAL, LAST_SEEN, SELF)?.count).toBe(1);
    const newer = post(2);
    expect(markRead(db, GENERAL, newer.id)).toBe(true);
    expect(unreadMark(db, GENERAL, LAST_SEEN, SELF)).toBeNull();
  });

});

describe('last read: when the Archive moves the mark', () => {
  it('marks the newest message seen once the banner is in, never while nothing is in view, and once per message', () => {
    expect(messageToMark(GENERAL, null, 'm2', undefined)).toBeUndefined();
    expect(messageToMark(GENERAL, OTHER, 'm2', undefined)).toBeUndefined();
    expect(messageToMark(GENERAL, GENERAL, undefined, undefined)).toBeUndefined();
    expect(messageToMark(GENERAL, GENERAL, 'm2', 'm2')).toBeUndefined();
    expect(messageToMark(null, null, 'm2', undefined)).toBeUndefined();
    expect(messageToMark(GENERAL, GENERAL, 'm3', 'm2')).toBe('m3');
  });
});

describe('last read: the banner', () => {
  const first = { firstId: 'm3', firstTs: 3 };
  const loaded = [1, 2, 3, 4].map((n) => ({ id: `m${n}`, ts: n }));

  it('points up while its first unread is above the view: older than the loaded window, or its top above the view', () => {
    expect(firstUnreadAbove({ firstId: 'm0', firstTs: 0 }, loaded, ['m3', 'm4'], null, 100)).toBe(true);
    expect(firstUnreadAbove(first, loaded, ['m3', 'm4'], 40, 100)).toBe(true);
    expect(firstUnreadAbove(first, loaded, ['m4'], null, 100)).toBe(true);
  });

  it('has nothing to point to once its first unread is on screen or below the view', () => {
    expect(firstUnreadAbove(first, loaded, ['m3', 'm4'], 120, 100)).toBe(false);
    expect(firstUnreadAbove(first, loaded, ['m1', 'm2'], null, 100)).toBe(false);
    expect(firstUnreadAbove({ firstId: 'm9', firstTs: 9 }, loaded, ['m4'], null, 100)).toBe(false);
  });
});

describe("last read: Discord's read state and the owner's messages", () => {
  const ack = (channelId: string, ackId: string): void => putReadStates(db, [{ channelId, ackId }], 'merge');

  it("counts nothing up to Discord's last read message: the owner's send or a read in another client", () => {
    post(3);
    const before = post(4);
    const after = post(5);
    ack(GENERAL, before.id);
    expect(unreadMark(db, GENERAL, LAST_SEEN, SELF)).toMatchObject({ count: 1, firstId: after.id });
    expect(newCount(GENERAL)).toBe(1);
  });

  it("when the owner sent the newest message, the channel is read", () => {
    post(3);
    const mine = post(4, GENERAL, SELF);
    ack(GENERAL, mine.id);
    expect(unreadMark(db, GENERAL, LAST_SEEN, SELF)).toBeNull();
    expect(newCount(GENERAL)).toBe(0);
  });

  it("leaves out the last account's messages before this session names one", () => {
    post(3, GENERAL, SELF);
    expect(unreadMark(db, GENERAL, LAST_SEEN, null)?.count).toBe(1);
    // Before one was recorded: the only account whose DMs are stored.
    db.prepare('UPDATE channels SET account_id = ? WHERE id = ?').run(SELF, OTHER);
    expect(lastReader(db)).toBe(SELF);
    db.prepare('UPDATE channels SET account_id = ? WHERE id = ?').run('u-other', GENERAL);
    expect(lastReader(db)).toBeNull();
    recordReader(db, SELF);
    expect(lastReader(db)).toBe(SELF);
    expect(unreadMark(db, GENERAL, LAST_SEEN, lastReader(db))).toBeNull();
  });

  it("counts a banner from its first unread, past the Archive's mark, still leaving out what Discord read", () => {
    const a = post(3);
    const b = post(4);
    markRead(db, GENERAL, b.id);
    expect(unreadMark(db, GENERAL, LAST_SEEN, SELF, a.id)).toMatchObject({ count: 2, firstId: a.id });
    ack(GENERAL, a.id);
    expect(unreadMark(db, GENERAL, LAST_SEEN, SELF, a.id)).toMatchObject({ count: 1, firstId: b.id });
  });

  it('tells whether the owner read a message: the Archive mark, Discord, or their own; a channel never opened only by Discord', () => {
    const a = post(3);
    const b = post(4);
    const mine = post(5, GENERAL, SELF);
    expect(messageRead(db, a.id, SELF)).toBe(false);
    expect(messageRead(db, mine.id, SELF)).toBe(true);
    markRead(db, GENERAL, a.id);
    expect(messageRead(db, a.id, SELF)).toBe(true);
    expect(messageRead(db, b.id, SELF)).toBe(false);
    ack(GENERAL, b.id);
    expect(messageRead(db, b.id, SELF)).toBe(true);
    expect(messageRead(db, 'missing', SELF)).toBe(false);
  });
});
