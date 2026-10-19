import { phoneAppEvent } from '@shared/phone';
import { encodeWire, decodeWire } from '@shared/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArchiveChanges } from '@shared/archiveChanges';
import { ARRIVAL } from '../src/core/arrival';
import { archiveHandlers } from '../src/core/archiveHandlers';
import { mediaQueueHandlers } from '../src/core/mediaQueue';
import { rawMessage, seedArchive, tempDb } from './helpers';

const CHANNEL = '200000000000000001';
const ATTACHMENT = '300000000000000001';
const NOW = Date.UTC(2026, 9, 18);
let db: ReturnType<typeof tempDb>;
let archive: ReturnType<typeof seedArchive>;
let changes: ArchiveChanges;
let handlers: ReturnType<typeof archiveHandlers>;
beforeEach(() => {
  db = tempDb(); archive = seedArchive(db, [{ id: CHANNEL }]); changes = new ArchiveChanges();
  const changed = changes.add.bind(changes);
  handlers = archiveHandlers({ ready: () => ({ db, archive }), emit: () => {}, noteChanged: changed,
    selfId: () => 'owner', lastSeenAt: () => NOW, backfillFromMs: () => NOW, applyTextTier: async () => {}, autoArchiveSinceMs: () => null });
});
afterEach(() => db.close());

describe('archive mutation notifications', () => {
  it('plain text inserts emit messages only, record seq and UTC day, and duplicates emit nothing', () => {
    const message = rawMessage(CHANNEL, NOW, 'plain', { guild_id: 'g1' });
    handlers.ingestMessages([message]);
    expect(changes.take()).toEqual({ changes: { [CHANNEL]: ['messages'] }, insertOnlyChannelIds: [CHANNEL], inserted: { afterSeq: 0, throughSeq: 1 } });
    expect(changes.takeTouched()).toEqual([{ channelId: CHANNEL, utcDay: '2026-10-18' }]);
    handlers.ingestMessages([message]);
    expect(changes.take().changes).toEqual({});
  });

  it('reactions emit reactions only, including snapshots ingested on an existing message', () => {
    const message = rawMessage(CHANNEL, NOW, 'plain', { guild_id: 'g1' });
    handlers.ingestMessages([message]); changes.take();
    handlers.applyGatewayEvent('MESSAGE_REACTION_ADD', { channel_id: CHANNEL, message_id: message.id, user_id: 'owner', emoji: { name: 'ok', id: null } });
    expect(changes.take()).toEqual({ changes: { [CHANNEL]: ['reactions'] }, insertOnlyChannelIds: [] });
    archive.ingestMessages([{ ...message, reactions: [] }], ARRIVAL.sync);
    expect(changes.take().changes).toEqual({ [CHANNEL]: ['reactions'] });
  });

  it('a download emits attachments and disk, without messages or links', () => {
    handlers.ingestMessages([rawMessage(CHANNEL, NOW, '', { guild_id: 'g1', attachments: [{ id: ATTACHMENT, filename: 'a.txt', url: 'url' }] })]);
    changes.take();
    const queue = mediaQueueHandlers(() => db, () => {}, changes.add.bind(changes));
    queue.attachmentStored(ATTACHMENT, 'hash', 1, null);
    expect(changes.take()).toEqual({ changes: { [CHANNEL]: ['attachments', 'disk'] }, insertOnlyChannelIds: [] });
    queue.attachmentFailed(ATTACHMENT, 'offline', false);
    expect(changes.take().changes).toEqual({ [CHANNEL]: ['attachments'] });
  });

  it('a mixed batch unions each row family and an edit removes insert-only classification', () => {
    const message = rawMessage(CHANNEL, NOW, 'https://example.test', { guild_id: 'g1', attachments: [{ id: ATTACHMENT, filename: 'a.txt', url: 'url' }] });
    handlers.ingestMessages([message]);
    expect(changes.take().changes).toEqual({ [CHANNEL]: ['messages', 'attachments', 'links'] });
    handlers.ingestMessages([rawMessage(CHANNEL, NOW + 1, 'new', { guild_id: 'g1' })]);
    handlers.applyGatewayEvent('MESSAGE_UPDATE', { id: message.id, channel_id: CHANNEL, content: 'edited' });
    const result = changes.take();
    expect(result.insertOnlyChannelIds).toEqual([]);
    expect(result.changes[CHANNEL]).toContain('edits');
  });
  it('newest-first batches of newer messages remain insert-only; shared URLs refresh existing link rows', () => {
    const first = rawMessage(CHANNEL, NOW, 'https://example.test', { guild_id: 'g1' });
    handlers.ingestMessages([first]); changes.take(); changes.takeTouched();
    handlers.ingestMessages([rawMessage(CHANNEL, NOW + 2, 'newest'), rawMessage(CHANNEL, NOW + 1, 'newer')]);
    expect(changes.take().insertOnlyChannelIds).toEqual([CHANNEL]);
    handlers.ingestMessages([rawMessage(CHANNEL, NOW + 3, first.content)]);
    const shared = changes.take();
    expect(shared.changes[CHANNEL]).toEqual(['messages', 'links']);
    expect(shared.insertOnlyChannelIds).toEqual([]);
  });

  it('rolls back notification metadata with an importer transaction', () => {
    archive.reportChangesWith(changes.add.bind(changes));
    expect(() => archive.atomically(() => {
      archive.ingestMessages([rawMessage(CHANNEL, NOW, 'rollback')], ARRIVAL.import);
      throw new Error('rollback');
    })).toThrow('rollback');
    expect(changes.take().changes).toEqual({});
    expect(changes.takeTouched()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) FROM messages').pluck().get()).toBe(0);
  });

  it('preserves the complete typed change payload over the phone wire', () => {
    const event = { type: 'archive-changed' as const, changes: { [CHANNEL]: ['messages' as const] }, insertOnlyChannelIds: [CHANNEL],
      inserted: { afterSeq: 0, throughSeq: 1 }, pluginIds: ['probe'], nameGuildIds: ['guild'] };
    expect(decodeWire(encodeWire(phoneAppEvent(event)))).toEqual(event);
  });

});
