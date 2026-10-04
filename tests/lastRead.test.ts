import { beforeEach, describe, expect, it } from 'vitest';
import { MS_PER_MIN } from '@shared/units';
import type { UnreadMark } from '@shared/contract';
import type { Db } from '../src/core/db';
import type { Archive } from '../src/core/archive';
import { markRead, unreadMark } from '../src/core/queries/readMarks';
import { directory } from '../src/core/queries/directory';
import { ARRIVAL } from '../src/core/arrival';
import { bannerAfterStart, messageToMark, watchStep } from '../src/renderer/src/state/lastReadRules';
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
  it('starts when a channel comes on screen or the channel changes, stops when the view leaves the screen', () => {
    expect(watchStep(null, GENERAL)).toBe('start');
    expect(watchStep(GENERAL, OTHER)).toBe('start');
    expect(watchStep(GENERAL, null)).toBe('stop');
    expect(watchStep(GENERAL, GENERAL)).toBe('none');
    expect(watchStep(null, null)).toBe('none');
  });

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
  const mark = (count: number, channelId = GENERAL): UnreadMark => ({ channelId, count, firstId: `m${count}`, firstTs: T0 + count });

  it('shows what was unread when a channel comes on screen; nothing when it was watched', () => {
    expect(bannerAfterStart(null, mark(3), GENERAL)).toEqual(mark(3));
    expect(bannerAfterStart(null, null, GENERAL)).toBeNull();
  });

  it('replaces another channel’s banner', () => {
    expect(bannerAfterStart(mark(3, OTHER), null, GENERAL)).toBeNull();
    expect(bannerAfterStart(mark(3, OTHER), mark(2), GENERAL)).toEqual(mark(2));
  });

  it('keeps its first unread when the same channel comes back on screen, adding what arrived meanwhile', () => {
    expect(bannerAfterStart(mark(3), mark(2), GENERAL)).toEqual({ ...mark(3), count: 5 });
    expect(bannerAfterStart(mark(3), null, GENERAL)).toEqual(mark(3));
  });
});
