import { beforeEach, describe, expect, it } from 'vitest';
import type { Archive } from '../src/core/archive';
import type { Db } from '../src/core/db';
import { applyGatewayEvent } from '../src/core/gatewayEvents';
import { messagesByIds } from '../src/core/queries/messages';
import { rawMessage, seedArchive, tempDb } from './helpers';

const CH = '200000000000000001';
const OTHER = '200000000000000002';
const NOW = Date.UTC(2026, 8, 25);

let db: Db;
let a: Archive;
let changed: string[];
const SELF = '100000000000000001';
const FRIEND = '100000000000000002';
let activity: [string, string][];
const deps = {
  changed: (id: string) => changed.push(id),
 
  backfillFromMs: () => 0,
  selfId: () => SELF,
  dmActivity: (channelId: string, lastMessageId: string) => activity.push([channelId, lastMessageId]),
  autoArchiveSinceMs: () => null,
  optedIn: () => undefined,
};
const row = (id: string) => db.prepare('SELECT content, deleted_at FROM messages WHERE id = ?').get(id) as { content: string; deleted_at: number | null } | undefined;

beforeEach(() => {
  db = tempDb();
  a = seedArchive(db, [{ id: CH }, { id: OTHER, optIn: false }]);
  changed = [];
  activity = [];
});

describe('gateway events', () => {
  it('archives, edits and deletes messages in opted-in channels, reporting each change', () => {
    const m = rawMessage(CH, NOW, 'hello');
    applyGatewayEvent(a, 'MESSAGE_CREATE', m, deps);
    expect(row(m.id)?.content).toBe('hello');
    applyGatewayEvent(a, 'MESSAGE_UPDATE', { ...m, content: 'hello again', edited_timestamp: new Date(NOW + 1).toISOString() }, deps);
    expect(row(m.id)?.content).toBe('hello again');
    applyGatewayEvent(a, 'MESSAGE_DELETE', { id: m.id, channel_id: CH }, deps);
    expect(row(m.id)?.deleted_at).not.toBeNull();
    expect(changed).toEqual([CH, CH, CH]);
  });

  it('ignores channels that are not archived', () => {
    const m = rawMessage(OTHER, NOW, 'not archived');
    applyGatewayEvent(a, 'MESSAGE_CREATE', m, deps);
    applyGatewayEvent(a, 'MESSAGE_DELETE_BULK', { ids: [m.id], channel_id: OTHER }, deps);
    expect(row(m.id)).toBeUndefined();
    expect(changed).toEqual([]);
  });
});

describe('reactions', () => {
  const THUMBS = { id: null, name: '👍', animated: false };
  const reactions = (id: string) => messagesByIds(db, [id])[0]!.reactions;
  const react = (t: 'MESSAGE_REACTION_ADD' | 'MESSAGE_REACTION_REMOVE', id: string, userId: string) =>
    applyGatewayEvent(a, t, { channel_id: CH, message_id: id, emoji: THUMBS, user_id: userId }, deps);

  it("counts everyone's reactions and marks the owner's own", () => {
    const m = rawMessage(CH, NOW, 'vote');
    applyGatewayEvent(a, 'MESSAGE_CREATE', m, deps);
    react('MESSAGE_REACTION_ADD', m.id, FRIEND);
    expect(reactions(m.id)).toEqual([{ emoji: THUMBS, count: 1, me: false }]);
    react('MESSAGE_REACTION_ADD', m.id, SELF);
    expect(reactions(m.id)).toEqual([{ emoji: THUMBS, count: 2, me: true }]);
    react('MESSAGE_REACTION_REMOVE', m.id, SELF);
    expect(reactions(m.id)).toEqual([{ emoji: THUMBS, count: 1, me: false }]);
  });

  it("the owner's reaction arriving twice (main's copy, then the gateway's) counts once", () => {
    const m = rawMessage(CH, NOW, 'vote');
    applyGatewayEvent(a, 'MESSAGE_CREATE', m, deps);
    const own = { channel_id: CH, message_id: m.id, emoji: THUMBS, user_id: SELF };
    expect(a.applyReaction('MESSAGE_REACTION_ADD', own, SELF)).toBe(true);
    changed = [];
    react('MESSAGE_REACTION_ADD', m.id, SELF);
    expect(reactions(m.id)).toEqual([{ emoji: THUMBS, count: 1, me: true }]);
    expect(changed).toEqual([]);
    expect(a.applyReaction('MESSAGE_REACTION_REMOVE', own, SELF)).toBe(true);
    react('MESSAGE_REACTION_REMOVE', m.id, SELF);
    expect(reactions(m.id)).toEqual([]);
  });
});
