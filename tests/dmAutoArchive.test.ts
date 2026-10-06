// Automatic DM archiving stores the first eligible message after enabling. Excludes requests, spam, declined DMs, and departed groups; the archive event starts main’s sync.
import { beforeEach, describe, expect, it } from 'vitest';
import { sharedEvent, type AppEvent } from '@shared/contract';
import { DM_CHANNEL_TYPE, GROUP_DM_CHANNEL_TYPE, snowflakeFromMs, type RawPrivateChannel } from '@shared/discord';
import { DEFAULT_ARCHIVE_SETTINGS, normalizeArchiveSettings } from '@shared/settings';
import { MS_PER_MIN } from '@shared/units';
import type { Archive } from '../src/core/archive';
import { archiveHandlers } from '../src/core/archiveHandlers';
import type { Db } from '../src/core/db';
import { applyGatewayEvent, type GatewayDeps } from '../src/core/gatewayEvents';
import { rawMessage, seedArchive, tempDb } from './helpers';

const SELF = '100000000000000001';
const OTHER_ACCOUNT = '100000000000000002';
const BOB = { id: '110000000000000001', username: 'bob' };
const CY = { id: '110000000000000002', username: 'cy' };
const DM = '400000000000000001';
const GROUP = '400000000000000002';
const REQUEST = '400000000000000003';
const SPAM = '400000000000000004';
const THEIRS = '400000000000000005';
const UNKNOWN = '400000000000000009';
const SINCE = Date.UTC(2026, 9, 1);
const after = (min: number): number => SINCE + min * MS_PER_MIN;

let db: Db;
let a: Archive;
let since: number | null;
let opted: string[];
const deps: GatewayDeps = {
  changed: () => undefined,
 
  backfillFromMs: () => 0,
  selfId: () => SELF,
  dmActivity: () => undefined,
  autoArchiveSinceMs: () => since,
  optedIn: (id) => void opted.push(id),
};
const channels: RawPrivateChannel[] = [
  { id: DM, type: DM_CHANNEL_TYPE, recipients: [BOB] },
  { id: GROUP, type: GROUP_DM_CHANNEL_TYPE, name: 'crew', owner_id: SELF, recipients: [BOB, CY] },
  { id: REQUEST, type: DM_CHANNEL_TYPE, recipients: [CY], is_message_request: true },
  { id: SPAM, type: DM_CHANNEL_TYPE, recipients: [CY], is_spam: true },
];

/** Separates the ids of messages sent in the same minute. */
let sent = 0;
/** A message from Bob in `channelId`, `min` minutes after the setting was turned on; each has its own id. */
const message = (channelId: string, min = 1) => rawMessage(channelId, after(min), `hi ${channelId}`, { author: BOB, id: snowflakeFromMs(after(min), ++sent) });
const send = (channelId: string, min?: number): void => applyGatewayEvent(a, 'MESSAGE_CREATE', message(channelId, min), deps);
const archived = (id: string): boolean => (db.prepare('SELECT opted_in FROM channels WHERE id = ?').pluck().get(id) as number | undefined) === 1;
const stored = (channelId: string): number => db.prepare('SELECT COUNT(*) FROM messages WHERE channel_id = ? AND content IS NOT NULL').pluck().get(channelId) as number;

beforeEach(() => {
  db = tempDb();
  a = seedArchive(db, []);
  a.replacePrivateChannels(SELF, channels, false, SINCE);
  a.upsertPrivateChannel(OTHER_ACCOUNT, { id: THEIRS, type: DM_CHANNEL_TYPE, recipients: [BOB] }, true);
  since = SINCE;
  opted = [];
});

describe('auto-archive', () => {
  it("archives the account's DM or group on a message after it was turned on, and stores that first message", () => {
    send(DM);
    send(GROUP);
    expect([archived(DM), archived(GROUP)]).toEqual([true, true]);
    expect([stored(DM), stored(GROUP)]).toEqual([1, 1]);
    expect(opted).toEqual([DM, GROUP]);
    // Archived already: the next message is stored with no second opt-in.
    send(DM, 2);
    expect(stored(DM)).toBe(2);
    expect(opted).toEqual([DM, GROUP]);
  });

  it('does nothing while off, or for a message from before it was turned on', () => {
    since = null;
    send(DM);
    since = SINCE;
    send(GROUP, 0);
    send(GROUP, -1);
    expect([archived(DM), archived(GROUP), stored(DM), stored(GROUP)]).toEqual([false, false, 0, 0]);
    expect(opted).toEqual([]);
  });

  it("skips requests, spam, another account's DM and an unknown one", () => {
    for (const id of [REQUEST, SPAM, THEIRS, UNKNOWN]) send(id);
    expect([REQUEST, SPAM, THEIRS, UNKNOWN].map(archived)).toEqual([false, false, false, false]);
    expect(opted).toEqual([]);
  });

  it('skips a DM the owner stopped archiving or declined; archiving it again by hand lifts that', () => {
    const { handlers } = core();
    handlers.setOptIn(DM, false);
    send(DM);
    expect([archived(DM), stored(DM)]).toEqual([false, 0]);
    handlers.setOptIn(DM, true);
    handlers.setOptIn(DM, false);
    handlers.setOptIn(DM, true);
    expect(archived(DM)).toBe(true);
  });

  it('skips a group left; a closed one-to-one DM reopens on its message and is archived', () => {
    a.closePrivateChannel(GROUP, SINCE);
    a.closePrivateChannel(DM, SINCE);
    send(GROUP);
    send(DM);
    expect([archived(GROUP), archived(DM), stored(DM)]).toEqual([false, true, 1]);
  });
});

/** Core's archive methods over the test archive, auto-archive on since SINCE, and the events they emit. */
function core() {
  const events: AppEvent[] = [];
  const handlers = archiveHandlers({
    ready: () => ({ db, archive: a }),
    emit: (e) => void events.push(e),
    noteChanged: () => undefined,
    backfillFromMs: () => 0,
    selfId: () => SELF,
    lastSeenAt: () => 0,
    applyTextTier: async () => undefined,
    autoArchiveSinceMs: () => since,
  });
  return { handlers, events };
}

describe('the channel to sync', () => {
  it('core names the channel archived, by auto-archive or by hand, so main syncs it; taking one out names none', () => {
    const { handlers, events } = core();
    handlers.applyGatewayEvent('MESSAGE_CREATE', message(DM));
    handlers.setOptIn(GROUP, true);
    handlers.setOptIn(GROUP, false);
    expect(events.filter((e) => e.type === 'opt-in-changed')).toEqual([
      { type: 'opt-in-changed', optedIn: DM },
      { type: 'opt-in-changed', optedIn: GROUP },
      { type: 'opt-in-changed' },
    ]);
    // Windows and the phone are told only that opt-ins changed: no hidden DM's id leaves main.
    expect(sharedEvent({ type: 'opt-in-changed', optedIn: DM })).toEqual({ type: 'opt-in-changed' });
  });
});

describe('the setting', () => {
  it('is off by default; turning it on keeps the time it was turned on', () => {
    expect(DEFAULT_ARCHIVE_SETTINGS.autoArchiveSinceMs).toBeNull();
    expect(normalizeArchiveSettings({}).autoArchiveSinceMs).toBeNull();
    expect(normalizeArchiveSettings({ autoArchiveSinceMs: SINCE }).autoArchiveSinceMs).toBe(SINCE);
    for (const bad of ['1', -1, 0, Number.NaN, null]) expect(normalizeArchiveSettings({ autoArchiveSinceMs: bad }).autoArchiveSinceMs).toBeNull();
  });
});
