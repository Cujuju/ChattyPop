import { beforeEach, describe, expect, it } from 'vitest';
import { MS_PER_MIN } from '@shared/units';
import type { UnreadMark } from '@shared/contract';
import type { Db } from '../src/core/db';
import type { Archive } from '../src/core/archive';
import { markViewed, unreadMark } from '../src/core/queries/readMarks';
import { directory } from '../src/core/queries/directory';
import { ARRIVAL } from '../src/core/arrival';
import { bannerAfterStart, watchStep } from '../src/renderer/src/state/lastReadRules';
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

  it('marking returns what was unread, then nothing until a newer message arrives', () => {
    const first = post(3);
    expect(markViewed(db, GENERAL, T0 + 10 * MS_PER_MIN, LAST_SEEN, SELF)).toMatchObject({ count: 1, firstId: first.id });
    expect(markViewed(db, GENERAL, T0 + 11 * MS_PER_MIN, LAST_SEEN, SELF)).toBeNull();
    expect(newCount(GENERAL)).toBe(0);
    const later = post(12);
    expect(unreadMark(db, GENERAL, LAST_SEEN, SELF)).toMatchObject({ count: 1, firstId: later.id });
  });

  it('a mark counts from itself, not the session fallback', () => {
    post(1);
    markViewed(db, GENERAL, T0, LAST_SEEN, SELF);
    expect(unreadMark(db, GENERAL, LAST_SEEN, SELF)?.count).toBe(1);
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
    post(3);
    post(4, OTHER);
    markViewed(db, GENERAL, T0 + 10 * MS_PER_MIN, LAST_SEEN, SELF);
    expect(unreadMark(db, OTHER, LAST_SEEN, SELF)?.count).toBe(1);
  });
});

describe('last read: when the Archive moves the mark', () => {
  it('starts when a channel comes on screen or the channel changes', () => {
    expect(watchStep(null, GENERAL, 'm1')).toBe('start');
    expect(watchStep(null, GENERAL, undefined)).toBe('start');
    expect(watchStep(GENERAL, OTHER, 'm1')).toBe('start');
  });

  it('advances while watched and showing the newest, never while scrolled to an older stretch', () => {
    expect(watchStep(GENERAL, GENERAL, 'm2')).toBe('advance');
    expect(watchStep(GENERAL, GENERAL, undefined)).toBe('none');
  });

  it('stops when the view leaves the screen', () => {
    expect(watchStep(GENERAL, null, 'm2')).toBe('stop');
    expect(watchStep(null, null, undefined)).toBe('none');
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
