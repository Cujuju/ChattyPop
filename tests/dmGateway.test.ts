// READY replaces one account’s DM list and closes missing entries. Deltas preserve absent fields and clear nulls. Activity IDs rise without storing unarchived content.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '@shared/contract';
import { DM_CHANNEL_TYPE, GROUP_DM_CHANNEL_TYPE, snowflakeFromMs, type RawPrivateChannel } from '@shared/discord';
import { SETTINGS_KEYS } from '@shared/settings';
import { MS_PER_MIN } from '@shared/units';
import type { Archive } from '../src/core/archive';
import { archiveHandlers } from '../src/core/archiveHandlers';
import { ARRIVAL } from '../src/core/arrival';
import { setSetting, type Db } from '../src/core/db';
import { applyGatewayEvent, type GatewayDeps } from '../src/core/gatewayEvents';
import { rawMessage, seedArchive, tempDb } from './helpers';

const SELF = '100000000000000001';
const OTHER_ACCOUNT = '100000000000000002';
const BOB = { id: '110000000000000001', username: 'bob', global_name: 'Bob', avatar: 'b0b' };
const CY = { id: '110000000000000002', username: 'cy' };
const DI = { id: '110000000000000003', username: 'di' };
const DM = '400000000000000001';
const GROUP = '400000000000000002';
const T0 = Date.UTC(2026, 8, 1);
const NOW = Date.UTC(2026, 9, 1);
const at = (n: number): string => snowflakeFromMs(T0 + n * MS_PER_MIN);

let db: Db;
let a: Archive;
let changed: string[];
let activity: [string, string][];
const deps: GatewayDeps = {
  changed: (id) => void changed.push(id),
 
  backfillFromMs: () => 0,
  selfId: () => SELF,
  dmActivity: (channelId, lastMessageId) => void activity.push([channelId, lastMessageId]),
  autoArchiveSinceMs: () => null,
  optedIn: () => undefined,
};
const dm: RawPrivateChannel = { id: DM, type: DM_CHANNEL_TYPE, recipients: [BOB], last_message_id: at(1) };
const group: RawPrivateChannel = { id: GROUP, type: GROUP_DM_CHANNEL_TYPE, name: 'crew', icon: 'c0ffee', owner_id: CY.id, recipients: [CY, DI], last_message_id: at(2) };

interface Row {
  name: string;
  account_id: string | null;
  last_message_id: string | null;
  closed_at: number | null;
  icon: string | null;
  owner_id: string | null;
  peer_id: string | null;
  is_message_request: number;
  is_spam: number;
}
const row = (id: string) => db.prepare('SELECT name, account_id, last_message_id, closed_at, icon, owner_id, peer_id, is_message_request, is_spam FROM channels WHERE id = ?').get(id) as Row | undefined;
const roster = (id: string) => db.prepare('SELECT r.value FROM channels c, json_each(c.recipients) r WHERE c.id = ? ORDER BY r.value').pluck().all(id);

beforeEach(() => {
  db = tempDb();
  a = seedArchive(db, []);
  changed = [];
  activity = [];
});

describe('READY replaces one account’s DM list', () => {
  it('stores each DM with its account, roster, owner and newest message', () => {
    a.replacePrivateChannels(SELF, [dm, group], false, NOW);
    expect(row(DM)).toMatchObject({ name: 'Bob', account_id: SELF, last_message_id: at(1), closed_at: null, peer_id: BOB.id });
    expect(row(GROUP)).toMatchObject({ name: 'crew', owner_id: CY.id, icon: 'c0ffee', peer_id: null });
    expect(roster(GROUP)).toEqual([CY.id, DI.id]);
  });

  it("closes the account's DMs missing from a full list, and never another account's or any row", () => {
    const theirs = '400000000000000003';
    a.replacePrivateChannels(SELF, [dm, group], false, NOW);
    a.replacePrivateChannels(OTHER_ACCOUNT, [{ id: theirs, type: DM_CHANNEL_TYPE, recipients: [DI] }], false, NOW);
    expect(row(DM)?.closed_at).toBeNull();
    a.replacePrivateChannels(SELF, [group], false, NOW + 1);
    expect(row(DM)?.closed_at).toBe(NOW + 1);
    expect(row(theirs)?.closed_at).toBeNull();
    // Listed again: open.
    a.replacePrivateChannels(SELF, [dm, group], false, NOW + 2);
    expect(row(DM)?.closed_at).toBeNull();
  });

  it('a partial list closes nothing', () => {
    a.replacePrivateChannels(SELF, [dm, group], false, NOW);
    a.replacePrivateChannels(SELF, [group], true, NOW + 1);
    expect(row(DM)?.closed_at).toBeNull();
  });

  it('claims a DM no account owns yet (an older build stored it) when READY lists it', () => {
    a.upsertPrivateChannel(null, dm, true);
    expect(row(DM)?.account_id).toBeNull();
    a.replacePrivateChannels(SELF, [dm], false, NOW);
    expect(row(DM)?.account_id).toBe(SELF);
  });

  it("claims and closes an unlisted unowned DM holding the account's own message; leaves other unowned DMs unowned", () => {
    const mine = '400000000000000005';
    const unknown = '400000000000000006';
    a.upsertPrivateChannel(null, { id: mine, type: DM_CHANNEL_TYPE, recipients: [BOB] }, true);
    a.upsertPrivateChannel(null, { id: unknown, type: DM_CHANNEL_TYPE, recipients: [CY] }, true);
    for (const id of [mine, unknown]) a.setOptIn(id, true);
    a.ingestMessages([rawMessage(mine, T0, 'hi', { author: { id: SELF, username: 'me' } }), rawMessage(unknown, T0, 'yo', { author: CY })], ARRIVAL.sync);
    // A partial list claims nothing it doesn't list.
    a.replacePrivateChannels(SELF, [dm], true, NOW);
    expect(row(mine)?.account_id).toBeNull();
    a.replacePrivateChannels(SELF, [dm], false, NOW);
    expect(row(mine)).toMatchObject({ account_id: SELF, closed_at: NOW });
    expect(row(unknown)).toMatchObject({ account_id: null, closed_at: null });
    a.replacePrivateChannels(OTHER_ACCOUNT, [], false, NOW);
    expect(row(unknown)?.account_id).toBeNull();
  });

  it('keeps message request and spam apart, each merged on its own: a payload without one keeps it', () => {
    a.replacePrivateChannels(SELF, [{ ...dm, is_message_request: true }, { ...group, is_spam: true }], false, NOW);
    expect(row(DM)).toMatchObject({ is_message_request: 1, is_spam: 0 });
    expect(row(GROUP)).toMatchObject({ is_message_request: 0, is_spam: 1 });
    // Spam stays spam when a payload clears only the request flag.
    a.upsertPrivateChannel(SELF, { ...group, is_message_request: false }, false);
    expect(row(GROUP)).toMatchObject({ is_message_request: 0, is_spam: 1 });
    a.upsertPrivateChannel(SELF, { ...dm, is_message_request: false, is_spam: false }, false);
    expect(row(DM)).toMatchObject({ is_message_request: 0, is_spam: 0 });
  });
});

describe('gateway deltas merge field by field', () => {
  beforeEach(() => a.replacePrivateChannels(SELF, [dm, group], false, NOW));

  it('a field absent from the payload keeps the stored value; null clears it', () => {
    applyGatewayEvent(a, 'CHANNEL_UPDATE', { id: GROUP, type: GROUP_DM_CHANNEL_TYPE }, deps);
    expect(row(GROUP)).toMatchObject({ name: 'crew', icon: 'c0ffee', owner_id: CY.id, last_message_id: at(2) });
    expect(roster(GROUP)).toEqual([CY.id, DI.id]);
    applyGatewayEvent(a, 'CHANNEL_UPDATE', { id: GROUP, type: GROUP_DM_CHANNEL_TYPE, icon: null, name: 'renamed' }, deps);
    expect(row(GROUP)).toMatchObject({ name: 'renamed', icon: null, owner_id: CY.id });
    expect(changed).toEqual(['', '']);
  });

  it("a group's name: absent keeps it; null names it by its people only once they are resolved", () => {
    applyGatewayEvent(a, 'CHANNEL_UPDATE', { id: GROUP, type: GROUP_DM_CHANNEL_TYPE, recipients: [CY] }, deps);
    expect(row(GROUP)?.name).toBe('crew');
    applyGatewayEvent(a, 'CHANNEL_UPDATE', { id: GROUP, type: GROUP_DM_CHANNEL_TYPE, name: null }, deps);
    expect(row(GROUP)?.name).toBe('crew');
    applyGatewayEvent(a, 'CHANNEL_UPDATE', { id: GROUP, type: GROUP_DM_CHANNEL_TYPE, name: null, recipients: [CY, DI] }, deps);
    expect(row(GROUP)?.name).toBe('cy, di');
  });

  it("a one-to-one DM is named by its person once READY resolves them, never 'Direct message' over a name", () => {
    const fresh = '400000000000000007';
    a.replacePrivateChannels(SELF, [dm, group, { id: fresh, type: DM_CHANNEL_TYPE }], false, NOW);
    expect(row(fresh)?.name).toBe('Direct message');
    a.replacePrivateChannels(SELF, [dm, group, { id: fresh, type: DM_CHANNEL_TYPE, recipients: [DI] }], false, NOW);
    expect(row(fresh)?.name).toBe('di');
    a.replacePrivateChannels(SELF, [dm, group, { id: fresh, type: DM_CHANNEL_TYPE }], false, NOW);
    expect(row(fresh)?.name).toBe('di');
  });

  it('the roster is replaced only by a payload carrying recipients', () => {
    applyGatewayEvent(a, 'CHANNEL_UPDATE', { ...group, recipients: [DI] }, deps);
    expect(roster(GROUP)).toEqual([DI.id]);
  });

  it('upserting one DM never lowers its newest message, so its rank stands', () => {
    applyGatewayEvent(a, 'CHANNEL_UPDATE', { ...group, last_message_id: at(0) }, deps);
    applyGatewayEvent(a, 'CHANNEL_UPDATE', { ...group, last_message_id: null }, deps);
    expect(row(GROUP)?.last_message_id).toBe(at(2));
  });

  it('CHANNEL_DELETE closes a DM and keeps it; CHANNEL_CREATE opens it again', () => {
    applyGatewayEvent(a, 'CHANNEL_DELETE', dm, deps);
    expect(row(DM)?.closed_at).not.toBeNull();
    applyGatewayEvent(a, 'CHANNEL_UPDATE', dm, deps);
    expect(row(DM)?.closed_at).not.toBeNull();
    applyGatewayEvent(a, 'CHANNEL_CREATE', dm, deps);
    expect(row(DM)?.closed_at).toBeNull();
  });

  it('a new DM from CHANNEL_CREATE belongs to the signed-in account', () => {
    const fresh = { id: '400000000000000009', type: DM_CHANNEL_TYPE, recipients: [DI], last_message_id: null };
    applyGatewayEvent(a, 'CHANNEL_CREATE', fresh, deps);
    expect(row(fresh.id)).toMatchObject({ name: 'di', account_id: SELF, peer_id: DI.id });
  });

  it("server channels' CHANNEL_* events are ignored", () => {
    const text = { id: '200000000000000009', type: 0, name: 'general', guild_id: '300000000000000001' };
    applyGatewayEvent(a, 'CHANNEL_CREATE', text, deps);
    applyGatewayEvent(a, 'CHANNEL_DELETE', text, deps);
    expect(row(text.id)).toBeUndefined();
    expect(changed).toEqual([]);
  });

  it('recipients join and leave a known group; the signed-in user is never on a roster', () => {
    applyGatewayEvent(a, 'CHANNEL_RECIPIENT_ADD', { channel_id: GROUP, user: BOB }, deps);
    applyGatewayEvent(a, 'CHANNEL_RECIPIENT_REMOVE', { channel_id: GROUP, user: CY }, deps);
    applyGatewayEvent(a, 'CHANNEL_RECIPIENT_ADD', { channel_id: GROUP, user: { id: SELF, username: 'me' } }, deps);
    applyGatewayEvent(a, 'CHANNEL_RECIPIENT_ADD', { channel_id: '400000000000000008', user: BOB }, deps);
    expect(roster(GROUP)).toEqual([BOB.id, DI.id]);
    expect(roster('400000000000000008')).toEqual([]);
    expect(changed).toEqual(['', '']);
  });
});

describe('DM activity', () => {
  beforeEach(() => a.replacePrivateChannels(SELF, [dm], false, NOW));

  it('a message in an unarchived DM raises its newest id and stores no content', () => {
    const m = rawMessage(DM, T0 + 5 * MS_PER_MIN, 'secret', { author: BOB });
    applyGatewayEvent(a, 'MESSAGE_CREATE', m, deps);
    expect(row(DM)?.last_message_id).toBe(m.id);
    expect(db.prepare('SELECT COUNT(*) FROM messages').pluck().get()).toBe(0);
    expect(activity).toEqual([[DM, m.id]]);
    // The row is patched (dm-activity), not the list re-read.
    expect(changed).toEqual([]);
  });

  it('only ever rises: an older message (arriving late) changes nothing', () => {
    a.touchChannel(DM, at(9));
    expect(a.touchChannel(DM, at(5))).toEqual({ rose: false, reopened: false });
    applyGatewayEvent(a, 'MESSAGE_CREATE', rawMessage(DM, T0 + 3 * MS_PER_MIN, 'late'), deps);
    expect(row(DM)?.last_message_id).toBe(at(9));
    expect(activity).toEqual([]);
  });

  it('an archived DM stores the message as well', () => {
    a.setOptIn(DM, true);
    const m = rawMessage(DM, T0 + 5 * MS_PER_MIN, 'kept', { author: BOB });
    applyGatewayEvent(a, 'MESSAGE_CREATE', m, deps);
    expect(activity).toEqual([[DM, m.id]]);
    expect(changed).toEqual([DM]);
  });

  it('a message opens a closed one-to-one DM again, as Discord does; a closed group stays closed and leaves sync', () => {
    a.replacePrivateChannels(SELF, [dm, group], false, NOW);
    for (const id of [DM, GROUP]) a.setOptIn(id, true);
    applyGatewayEvent(a, 'CHANNEL_DELETE', dm, deps);
    applyGatewayEvent(a, 'CHANNEL_DELETE', group, deps);
    expect(a.optedInChannels(SELF)).toEqual([DM]);
    changed = [];
    // Even a message older than the newest one known (a late one) reopens it.
    applyGatewayEvent(a, 'MESSAGE_CREATE', rawMessage(DM, T0, 'back', { author: BOB }), deps);
    expect(row(DM)?.closed_at).toBeNull();
    expect(changed).toContain('');
    applyGatewayEvent(a, 'MESSAGE_CREATE', rawMessage(GROUP, T0 + 9 * MS_PER_MIN, 'late', { author: CY }), deps);
    expect(row(GROUP)?.closed_at).not.toBeNull();
    expect(a.optedInChannels(SELF)).toEqual([DM]);
  });

  it("a server's message is no DM activity, and costs no DM lookup", () => {
    const server = seedArchive(db, [{ id: '200000000000000001' }]);
    const touch = vi.spyOn(server, 'touchChannel');
    applyGatewayEvent(server, 'MESSAGE_CREATE', rawMessage('200000000000000001', T0, 'hi', { guild_id: '300000000000000001' }), deps);
    expect(activity).toEqual([]);
    expect(touch).not.toHaveBeenCalled();
  });
});

/** Core's archive methods over the test archive, and the events they emit. */
function core() {
  const events: AppEvent[] = [];
  const handlers = archiveHandlers({
    ready: () => ({ db, archive: a }),
    emit: (e) => void events.push(e),
    noteChanged: (id) => void changed.push(id),
    backfillFromMs: () => 0,
    selfId: () => SELF,
    lastSeenAt: () => 0,
    applyTextTier: async () => undefined,
    autoArchiveSinceMs: () => null,
  });
  return { handlers, events };
}

describe('DM events under privacy mode', () => {
  beforeEach(() => a.replacePrivateChannels(SELF, [dm], false, NOW));

  it("a hidden DM's activity reaches no view, phone or plugin", () => {
    const { handlers, events } = core();
    handlers.applyGatewayEvent('MESSAGE_CREATE', rawMessage(DM, T0 + 5 * MS_PER_MIN, 'seen', { author: BOB }));
    a.setChannelPolicy(DM, { hideInPrivacy: true });
    setSetting(db, SETTINGS_KEYS.privacyMode, true);
    handlers.applyGatewayEvent('MESSAGE_CREATE', rawMessage(DM, T0 + 6 * MS_PER_MIN, 'hidden', { author: BOB }));
    expect(events.filter((e) => e.type === 'dm-activity').map((e) => e.type === 'dm-activity' && e.lastMessageId)).toEqual([snowflakeFromMs(T0 + 5 * MS_PER_MIN)]);
  });
});

describe("main's read state updates", () => {
  beforeEach(() => a.replacePrivateChannels(SELF, [dm, group], false, NOW));

  it('patch rows in place (read-states-changed), never re-read the list, and leave hidden channels out', () => {
    const { handlers, events } = core();
    a.setChannelPolicy(GROUP, { hideInPrivacy: true });
    setSetting(db, SETTINGS_KEYS.privacyMode, true);
    handlers.putReadStates([{ channelId: DM, mentionCount: 1 }, { channelId: GROUP, mentionCount: 4 }], 'merge');
    expect(changed).toEqual([]);
    expect(events).toEqual([{ type: 'read-states-changed', states: [{ channelId: DM, mentionCount: 1 }] }]);
    // READY's replace every channel's: the list is read again.
    handlers.putReadStates([], 'replace');
    expect(changed).toEqual(['']);
  });
});
