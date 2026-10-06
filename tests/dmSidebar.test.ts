// Tests DM sidebar unread/mute state, search, filters, folds, segment count, and row ages.
import { describe, expect, it } from 'vitest';
import { DM_CHANNEL_TYPE, DM_GUILD_ID, GROUP_DM_CHANNEL_TYPE, MUTED_FOREVER, snowflakeFromMs } from '@shared/discord';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MIN } from '@shared/units';
import {
  dmSections,
  isClosedGroup,
  isMuted,
  isOpenOneToOne,
  isReadOnlyDm,
  isUnread,
  matchesSearch,
  unreadDmCount,
  type DmChannel,
} from '../src/renderer/src/state/dmRules';
import { listAge, shortDate, weekdayDate, yearDate } from '../src/renderer/src/ui/dates';

const NOW = new Date(2026, 9, 1, 12, 0).getTime();
const OLDER = snowflakeFromMs(NOW - MS_PER_HOUR);
const NEWER = snowflakeFromMs(NOW - MS_PER_MIN);

type DmOverrides = Partial<DmChannel['dm']> & { id?: string; name?: string; kind?: number; mentionCount?: number };

function dm(o: DmOverrides = {}): DmChannel {
  const { id = '200000000000000001', name = 'Billie', kind = DM_CHANNEL_TYPE, mentionCount = 0, ...block } = o;
  return {
    id,
    guildId: DM_GUILD_ID,
    name,
    kind,
    parentId: null,
    optedIn: false,
    messageCount: 0,
    newCount: 0,
    notableCount: 0,
    mentionCount,
    lastTs: null,
    localAiOnly: false,
    textTier: null,
    peer: null,
    icon: null,
    hideInPrivacy: false,
    dm: {
      recipients: [{ id: '300000000000000001', name, avatar: null }],
      rosterKnown: true,
      ownerId: null,
      lastMessageId: OLDER,
      ackId: OLDER,
      muteEndsMs: null,
      closed: false,
      request: false,
      archived: 'never',
      preview: null,
      ...block,
    },
  };
}

describe('DM read and mute state', () => {
  it('is unread when the newest message is past the ack, or Discord counts some', () => {
    expect(isUnread(dm())).toBe(false);
    expect(isUnread(dm({ lastMessageId: NEWER, ackId: OLDER }))).toBe(true);
    expect(isUnread(dm({ ackId: null }))).toBe(false);
    expect(isUnread(dm({ ackId: null, mentionCount: 2 }))).toBe(true);
    expect(isUnread(dm({ lastMessageId: null, ackId: null }))).toBe(false);
  });

  it('is muted until its end time, and forever', () => {
    expect(isMuted(dm(), NOW)).toBe(false);
    expect(isMuted(dm({ muteEndsMs: NOW + MS_PER_MIN }), NOW)).toBe(true);
    expect(isMuted(dm({ muteEndsMs: NOW }), NOW)).toBe(false);
    expect(isMuted(dm({ muteEndsMs: MUTED_FOREVER }), NOW)).toBe(true);
  });
});

describe('DM list', () => {
  const group = dm({ id: '200000000000000002', name: 'Weekend crew', kind: GROUP_DM_CHANNEL_TYPE, recipients: [{ id: '300000000000000002', name: 'Samwise', avatar: null }] });
  const unread = dm({ id: '200000000000000003', name: 'Stat', lastMessageId: NEWER });
  const request = dm({ id: '200000000000000004', name: 'Spam', request: true, lastMessageId: NEWER });
  const closed = dm({ id: '200000000000000005', name: 'Old', closed: true, request: true });
  const all = [group, unread, request, closed];
  const ids = (cs: DmChannel[]): string[] => cs.map((c) => c.name);

  it('searches names and members, any case', () => {
    expect(matchesSearch(group, '  SAMW ')).toBe(true);
    expect(matchesSearch(group, 'crew')).toBe(true);
    expect(matchesSearch(group, 'billie')).toBe(false);
    expect(matchesSearch(group, '')).toBe(true);
  });

  it('folds requests and closed DMs (closed wins), keeping order', () => {
    expect(dmSections(all, '', 'all')).toEqual({ list: [group, unread], requests: [request], closed: [closed] });
  });

  it('filters by unread and by groups across the list and its folds', () => {
    const unreadOnly = dmSections(all, '', 'unread');
    expect([ids(unreadOnly.list), ids(unreadOnly.requests), ids(unreadOnly.closed)]).toEqual([['Stat'], ['Spam'], []]);
    expect(ids(dmSections(all, '', 'groups').list)).toEqual(['Weekend crew']);
  });

  it('counts open, unread, unmuted conversations for the DMs segment', () => {
    const mutedUnread = dm({ id: '200000000000000006', lastMessageId: NEWER, muteEndsMs: MUTED_FOREVER });
    expect(unreadDmCount([...all, mutedUnread], NOW)).toBe(1);
  });
});

describe('listAge', () => {
  const today = new Date(2026, 9, 1).getTime();

  it('reads minutes and hours within a day', () => {
    expect(listAge(NOW - 30 * 1000, NOW, today)).toBe('now');
    expect(listAge(NOW - 5 * MS_PER_MIN, NOW, today)).toBe('5m');
    expect(listAge(NOW - 2 * MS_PER_HOUR - MS_PER_MIN, NOW, today)).toBe('2h');
  });

  it('names the weekday within the past week, then the date, with the year when it differs', () => {
    const threeDays = NOW - 3 * MS_PER_DAY;
    expect(weekdayDate(threeDays).startsWith(listAge(threeDays, NOW, today))).toBe(true);
    const twoWeeks = NOW - 14 * MS_PER_DAY;
    expect(listAge(twoWeeks, NOW, today)).toBe(shortDate(twoWeeks));
    const lastYear = new Date(2025, 8, 12).getTime();
    expect(listAge(lastYear, NOW, today)).toBe(yearDate(lastYear));
  });
});

describe('read-only conversations', () => {
  it('a message request and a group left take no message and no archiving; New message offers no request', () => {
    expect(isReadOnlyDm(dm({ request: true }))).toBe(true);
    expect(isReadOnlyDm(dm({ kind: GROUP_DM_CHANNEL_TYPE, closed: true }))).toBe(true);
    expect(isReadOnlyDm(dm({ closed: true }))).toBe(false);
    expect(isOpenOneToOne(dm())).toBe(true);
    expect([dm({ request: true }), dm({ closed: true }), dm({ kind: GROUP_DM_CHANNEL_TYPE })].some(isOpenOneToOne)).toBe(false);
  });
});

describe('closed conversations', () => {
  it('a closed group takes no message (no composer); a closed one-to-one DM does, as Discord reopens it', () => {
    expect(isClosedGroup(dm({ kind: GROUP_DM_CHANNEL_TYPE, closed: true }))).toBe(true);
    expect(isClosedGroup(dm({ kind: GROUP_DM_CHANNEL_TYPE }))).toBe(false);
    expect(isClosedGroup(dm({ closed: true }))).toBe(false);
  });
});
