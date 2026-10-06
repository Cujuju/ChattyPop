// Lists the signed-in account’s DMs by newest activity, with roster, read/mute state, archive state, and privacy-aware retained previews. Mentions use the roster.
import { beforeEach, describe, expect, it } from 'vitest';
import { DM_CHANNEL_TYPE, DM_GUILD_ID, GROUP_DM_CHANNEL_TYPE, MUTED_FOREVER, snowflakeFromMs, type RawPrivateChannel, type RawUser } from '@shared/discord';
import type { DirectoryChannel } from '@shared/contract';
import { SETTINGS_KEYS } from '@shared/settings';
import { MS_PER_MIN } from '@shared/units';
import type { Archive } from '../src/core/archive';
import { ARRIVAL } from '../src/core/arrival';
import { setSetting, type Db } from '../src/core/db';
import { directory } from '../src/core/queries/directory';
import { mentionCandidates } from '../src/core/queries/mentions';
import { putReadStates } from '../src/core/queries/readStates';
import { rawMessage, seedArchive, tempDb } from './helpers';

const SELF = '100000000000000001';
const OTHER_ACCOUNT = '100000000000000002';
const ME = { id: SELF, username: 'me' };
const BOB = { id: '110000000000000001', username: 'bob', global_name: 'Bob', avatar: 'b0b' };
const CY = { id: '110000000000000002', username: 'cy', avatar: null };
const DI = { id: '110000000000000003', username: 'di', avatar: null };
const DM = '400000000000000001';
const GROUP = '400000000000000002';
const SECRET = '200000000000000001';
const T0 = Date.UTC(2026, 8, 1);
const NOW = Date.UTC(2026, 9, 1);
const at = (n: number): number => T0 + n * MS_PER_MIN;
const idAt = (n: number): string => snowflakeFromMs(at(n));

let db: Db;
let a: Archive;
const dm: RawPrivateChannel = { id: DM, type: DM_CHANNEL_TYPE, recipients: [BOB], last_message_id: idAt(1) };
const group: RawPrivateChannel = { id: GROUP, type: GROUP_DM_CHANNEL_TYPE, name: 'crew', owner_id: CY.id, recipients: [DI, CY], last_message_id: idAt(2) };
const dms = (self: string | null = SELF): DirectoryChannel[] => directory(db, 0, self).find((g) => g.id === DM_GUILD_ID)!.channels;
const block = (id: string, self: string | null = SELF) => dms(self).find((c) => c.id === id)?.dm;

beforeEach(() => {
  db = tempDb();
  a = seedArchive(db, [{ id: SECRET, name: 'secret' }]);
  a.replacePrivateChannels(SELF, [dm, group], false, NOW);
});

describe('directory: DMs', () => {
  it("fills each DM's block from the gateway's list and read states", () => {
    putReadStates(db, [{ channelId: DM, mentionCount: 1, ackId: idAt(0), muteEndsMs: MUTED_FOREVER }], 'merge');
    expect(block(DM)).toEqual({
      recipients: [{ id: BOB.id, name: 'Bob', avatar: 'b0b' }],
      rosterKnown: true,
      ownerId: null,
      lastMessageId: idAt(1),
      ackId: idAt(0),
      muteEndsMs: MUTED_FOREVER,
      closed: false,
      request: false,
      archived: 'never',
      preview: null,
    });
    expect(block(GROUP)).toMatchObject({ recipients: [{ id: CY.id, name: 'cy' }, { id: DI.id, name: 'di' }], ownerId: CY.id, ackId: null, muteEndsMs: null });
    // Server channels carry no block.
    expect(directory(db, 0, SELF).flatMap((g) => g.channels).find((c) => c.id === SECRET)?.dm).toBeUndefined();
  });

  it('orders DMs by their newest message, a quiet DM by its own id; a new message moves it up', () => {
    const quiet = { id: '400000000000000003', type: DM_CHANNEL_TYPE, recipients: [CY] };
    a.replacePrivateChannels(SELF, [dm, group, quiet], false, NOW);
    expect(dms().map((c) => c.id)).toEqual([GROUP, DM, quiet.id]);
    a.touchChannel(DM, idAt(3));
    expect(dms().map((c) => c.id)).toEqual([DM, GROUP, quiet.id]);
    // One DM upserted again (a gateway delta without activity) keeps its place.
    a.upsertPrivateChannel(SELF, { id: GROUP, type: GROUP_DM_CHANNEL_TYPE, name: 'crew 2' }, false);
    expect(dms().map((c) => c.id)).toEqual([DM, GROUP, quiet.id]);
  });

  it("lists only the signed-in account's DMs: an unclaimed one (an older build stored it) shows for no account", () => {
    const theirs = '400000000000000004';
    const unclaimed = '400000000000000005';
    a.replacePrivateChannels(OTHER_ACCOUNT, [{ id: theirs, type: DM_CHANNEL_TYPE, recipients: [CY] }], false, NOW);
    a.upsertPrivateChannel(null, { id: unclaimed, type: DM_CHANNEL_TYPE, recipients: [DI] }, true);
    expect(dms().map((c) => c.id).sort()).toEqual([DM, GROUP]);
    expect(dms(OTHER_ACCOUNT).map((c) => c.id)).toEqual([theirs]);
    // Before READY names anyone, no DM shows.
    expect(dms(null)).toEqual([]);
  });

  it('marks closed DMs, and requests: a message request or spam, either one', () => {
    a.replacePrivateChannels(SELF, [{ ...group, is_message_request: true }], false, NOW);
    expect(block(DM)?.closed).toBe(true);
    expect(block(GROUP)).toMatchObject({ closed: false, request: true });
    a.upsertPrivateChannel(SELF, { ...group, is_message_request: false, is_spam: true }, false);
    expect(block(GROUP)?.request).toBe(true);
    a.upsertPrivateChannel(SELF, { ...group, is_spam: false }, false);
    expect(block(GROUP)?.request).toBe(false);
  });

  it("archived: 'on' while opted in, 'stopped' once out with history kept, else 'never'", () => {
    expect(block(DM)?.archived).toBe('never');
    a.setOptIn(DM, true);
    a.ingestMessages([rawMessage(DM, at(1), 'hi', { author: BOB })], ARRIVAL.sync);
    expect(block(DM)?.archived).toBe('on');
    a.setOptIn(DM, false);
    expect(block(DM)?.archived).toBe('stopped');
  });

  it('recipients are the roster alone, empty while it is unknown; the face (kept peer, else newest other sender) is peer', () => {
    const legacy = '400000000000000006';
    a.upsertPrivateChannel(SELF, { id: legacy, type: DM_CHANNEL_TYPE }, true);
    a.setOptIn(legacy, true);
    a.ingestMessages([rawMessage(legacy, at(1), 'hi', { author: CY }), rawMessage(legacy, at(2), 'yo', { author: ME })], ARRIVAL.sync);
    const row = () => dms().find((c) => c.id === legacy)!;
    expect(row().dm).toMatchObject({ recipients: [], rosterKnown: false });
    expect(row().peer).toEqual({ id: CY.id, avatar: null });
    db.prepare('UPDATE channels SET peer_id = ? WHERE id = ?').run(DI.id, legacy);
    expect(row().peer).toEqual({ id: DI.id, avatar: null });
    expect(row().dm?.recipients).toEqual([]);
  });

  it('a known roster ends the face search: no history is read for it', () => {
    const known = '400000000000000007';
    a.upsertPrivateChannel(SELF, { id: known, type: DM_CHANNEL_TYPE, recipients: [] }, true);
    a.setOptIn(known, true);
    a.ingestMessages([rawMessage(known, at(1), 'hi', { author: CY })], ARRIVAL.sync);
    expect(dms().find((c) => c.id === known)?.peer).toBeNull();
    expect(dms().find((c) => c.id === known)?.dm).toMatchObject({ recipients: [], rosterKnown: true });
  });
});

describe('directory: DM preview', () => {
  beforeEach(() => a.setOptIn(DM, true));
  const ingest = (n: number, content: string, author: RawUser = BOB) => a.ingestMessages([rawMessage(DM, at(n), content, { author })], ARRIVAL.sync);

  it('is the newest message that is not deleted, by its author', () => {
    ingest(1, 'first');
    ingest(2, 'second', ME);
    expect(block(DM)?.preview).toEqual({ authorName: 'me', text: 'second' });
    a.markDeleted(DM, idAt(2), NOW);
    expect(block(DM)?.preview).toEqual({ authorName: 'Bob', text: 'first' });
  });

  it('skips a message naming a channel privacy mode hides, and shows nothing of a hidden DM', () => {
    ingest(1, 'visible');
    ingest(2, `see <#${SECRET}>`);
    a.setChannelPolicy(SECRET, { hideInPrivacy: true });
    setSetting(db, SETTINGS_KEYS.privacyMode, true);
    expect(block(DM)?.preview?.text).toBe('visible');
    a.setChannelPolicy(DM, { hideInPrivacy: true });
    expect(block(DM)).toBeUndefined();
  });

  it('shows the text retention kept: none once pruned', () => {
    ingest(1, 'old words');
    db.prepare("UPDATE messages SET content = '', raw_json = NULL, pruned_at = ? WHERE id = ?").run(NOW, idAt(1));
    expect(block(DM)?.preview).toEqual({ authorName: 'Bob', text: '' });
  });
});

describe("a DM's @ list", () => {
  const names = () => mentionCandidates(db, SELF, GROUP, '', 10).map((c) => (c.kind === 'user' ? c.name : c.kind)).sort();

  it("offers a group's whole roster, not only who has posted", () => {
    expect(names()).toEqual(['cy', 'di']);
  });

  it('never offers someone removed from the group, though they posted there; nor lists them as a recipient', () => {
    a.setOptIn(GROUP, true);
    a.ingestMessages([rawMessage(GROUP, at(1), 'bye', { author: CY })], ARRIVAL.sync);
    a.changeRecipient(GROUP, CY, false, SELF);
    expect(names()).toEqual(['di']);
    expect(block(GROUP)?.recipients.map((p) => p.id)).toEqual([DI.id]);
  });
});
