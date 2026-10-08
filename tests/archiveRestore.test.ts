import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_KEYS } from '@shared/settings';
import { MS_PER_S } from '@shared/units';
import { setSetting, type Db } from '../src/core/db';
import { messagePage, messageWindow } from '../src/core/queries/messages';
import { ARRIVAL } from '../src/core/arrival';
import { archiveHandlers } from '../src/core/archiveHandlers';
import { rawMessage, seedArchive, tempDb } from './helpers';

const CHANNEL = '200000000000000001';
const HIDDEN = '200000000000000002';
const PAGE_SIZE = 6;
const HISTORY_SIZE = 25;
const START = Date.UTC(2026, 9, 7);
let db: Db;
let archive: ReturnType<typeof seedArchive>;

beforeEach(() => {
  db = tempDb();
  archive = seedArchive(db, [{ id: CHANNEL }, { id: HIDDEN }]);
  archive.ingestMessages(Array.from({ length: HISTORY_SIZE }, (_, i) => rawMessage(CHANNEL, START + i * MS_PER_S, `m${i}`, { nonce: String(i) })), ARRIVAL.gateway);
});

describe('archive restore window contract', () => {
  it('returns the same page and correct live boundary for older and newest anchors', () => {
    const all = messagePage(db, { channelId: CHANNEL, limit: HISTORY_SIZE });
    for (const around of [all[0]!.id, all.at(-1)!.id]) {
      const query = { channelId: CHANNEL, limit: PAGE_SIZE, around };
      const window = messageWindow(db, query);
      expect(window.items).toEqual(messagePage(db, query));
      expect(window.reachesNewest).toBe(around === all.at(-1)!.id);
    }
    expect(all.map((m) => m.nonce)).toEqual(Array.from({ length: HISTORY_SIZE }, (_, i) => String(i)));
  });

  it('falls back to newest when the anchor is gone and handles an empty channel', () => {
    const query = { channelId: CHANNEL, limit: PAGE_SIZE };
    expect(messageWindow(db, { ...query, around: 'missing' })).toEqual({ items: messagePage(db, query), reachesNewest: true });
    expect(messageWindow(db, { channelId: HIDDEN, limit: PAGE_SIZE })).toEqual({ items: [], reachesNewest: true });
  });

  it('uses the same privacy scope for the page and newest boundary', () => {
    archive.setChannelPolicy(HIDDEN, { hideInPrivacy: true });
    setSetting(db, SETTINGS_KEYS.privacyMode, true);
    const newestHidden = rawMessage(CHANNEL, START + HISTORY_SIZE * MS_PER_S, `<#${HIDDEN}>`);
    archive.ingestMessages([newestHidden], ARRIVAL.gateway);
    const visible = messagePage(db, { channelId: CHANNEL, limit: HISTORY_SIZE });
    const result = messageWindow(db, { channelId: CHANNEL, limit: PAGE_SIZE, around: visible.at(-1)!.id });
    expect(result.reachesNewest).toBe(true);
    expect(result.items.some((m) => m.id === newestHidden.id)).toBe(false);
    expect(messageWindow(db, { channelId: HIDDEN, limit: PAGE_SIZE }).items).toEqual([]);
  });

  it('allows append-only catch-up for newest inserts, but refreshes late inserts, edits and deletes', () => {
    const noteChanged = vi.fn();
    const handlers = archiveHandlers({
      ready: () => ({ db, archive }), emit: () => {}, noteChanged,
      backfillFromMs: () => START, selfId: () => null, lastSeenAt: () => START,
      applyTextTier: async () => {}, autoArchiveSinceMs: () => null,
    });
    const newest = rawMessage(CHANNEL, START + HISTORY_SIZE * MS_PER_S, 'newest', { guild_id: 'guild' });
    const late = rawMessage(CHANNEL, START - MS_PER_S, 'late', { guild_id: 'guild' });
    handlers.applyGatewayEvent('MESSAGE_CREATE', newest);
    handlers.applyGatewayEvent('MESSAGE_CREATE', late);
    handlers.applyGatewayEvent('MESSAGE_UPDATE', { id: newest.id, channel_id: CHANNEL, content: 'edited' });
    handlers.applyGatewayEvent('MESSAGE_DELETE', { id: newest.id, channel_id: CHANNEL });
    expect(noteChanged.mock.calls).toEqual([[CHANNEL, true], [CHANNEL, false], [CHANNEL, false], [CHANNEL, false]]);
  });
});
