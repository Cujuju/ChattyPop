import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETTINGS_KEYS, normalizeCountedBots } from '@shared/settings';
import type { RawUser } from '@shared/discord';
import { ARRIVAL } from '../src/core/arrival';
import type { Archive } from '../src/core/archive';
import { compressRawJson, openDb, setSetting, type Db } from '../src/core/db';
import { storedBotAuthors } from '../src/core/laterMigrations';
import { upsertUser } from '../src/core/people';
import { watchNameWrites } from '../src/core/nameWrites';
import { archivedBots } from '../src/core/queries/bots';
import { directory } from '../src/core/queries/directory';
import { markRead, unreadMark, unreadSnapshot } from '../src/core/queries/readMarks';
import { putReadStates } from '../src/core/queries/readStates';
import { NOTABLE_SUBJECT } from '../src/core/jev/notable';
import { applyMigrations, migrationIndex, rawMessage, seedArchive, tempDb, tempDir } from './helpers';

const CH = 'c1';
const OTHER = 'c2';
const SELF = 'self';
const A: RawUser = { id: 'bot-a', username: 'alpha_bot', global_name: 'Alpha', bot: true };
const B: RawUser = { id: 'bot-b', username: 'beta_bot', bot: true };
let db: Db;
let archive: Archive;
let ts: number;
beforeEach(() => {
  db = tempDb();
  archive = seedArchive(db, [{ id: CH }, { id: OTHER }]);
  ts = Date.UTC(2026, 9, 1);
});
afterEach(() => db.close());
const post = (author: RawUser, channelId = CH, content = 'message') => {
  const m = rawMessage(channelId, ++ts, content, { author });
  archive.ingestMessages([m], ARRIVAL.gateway);
  db.prepare('INSERT INTO jev_judgments (message_id, subject, value, model, judged_at) VALUES (?, ?, 1, ?, 0)').run(m.id, NOTABLE_SUBJECT, 'm');
  return m;
};
const counts = (channelId = CH) => directory(db, 0, SELF).flatMap((g) => g.channels).find((c) => c.id === channelId)!;

describe('bot count selection', () => {
  it('defaults off and applies each selected bot to banner, sidebar and notable counts', () => {
    const a = post(A);
    const b = post(B);
    const human = post({ id: 'human', username: 'human' });
    post({ id: SELF, username: SELF, bot: true });
    const opening = unreadSnapshot(db, CH, 0, SELF);
    expect(opening).toEqual({ boundary: { id: a.id, ts: ts - 3 }, unread: { channelId: CH, count: 1, firstId: human.id, firstTs: ts - 1 } });
    for (const [ids, count, firstId] of [[[], 1, human.id], [[A.id], 2, a.id], [[A.id, B.id, SELF], 3, a.id], [[B.id], 2, b.id], [[], 1, human.id]] as const) {
      setSetting(db, SETTINGS_KEYS.countedBots, ids);
      expect(counts()).toMatchObject({ newCount: count, notableCount: count });
      expect(unreadMark(db, CH, 0, SELF)).toMatchObject({ count, firstId });
      expect(unreadMark(db, CH, 0, SELF, opening.boundary!)).toMatchObject({ count, firstId });
    }
  });

  it('keeps read marks, external acknowledgments and privacy restrictions when a bot is enabled', () => {
    const read = post(A);
    const acked = post(A);
    const first = post(A);
    post(A, CH, `hidden <#${OTHER}>`);
    post(A, OTHER);
    markRead(db, CH, read.id);
    putReadStates(db, [{ channelId: CH, ackId: acked.id }], 'merge');
    db.prepare('UPDATE channels SET hide_in_privacy = 1 WHERE id = ?').run(OTHER);
    setSetting(db, SETTINGS_KEYS.privacyMode, true);
    setSetting(db, SETTINGS_KEYS.countedBots, [A.id]);
    expect(counts()).toMatchObject({ newCount: 1, notableCount: 1 });
    expect(unreadMark(db, CH, 0, SELF)).toMatchObject({ count: 1, firstId: first.id });
    expect(unreadMark(db, CH, 0, SELF, read.id)).toMatchObject({ count: 1, firstId: first.id });
    expect(unreadMark(db, OTHER, 0, SELF)).toBeNull();
    expect(unreadMark(db, CH, 0, SELF, post({ id: 'human', username: 'human' }, OTHER).id)).toBeNull();
  });

  it('retains an empty bot-only opening boundary after local reads and after the source row disappears', () => {
    const a = post(A);
    const b = post(B);
    const opening = unreadSnapshot(db, CH, 0, SELF);
    expect(opening.unread).toBeNull();
    expect(opening.boundary).toEqual({ id: a.id, ts: ts - 1 });
    markRead(db, CH, b.id);
    setSetting(db, SETTINGS_KEYS.countedBots, [A.id, B.id]);
    expect(unreadMark(db, CH, 0, SELF)).toBeNull();
    expect(unreadMark(db, CH, 0, SELF, opening.boundary!)).toMatchObject({ count: 2, firstId: a.id });
    db.prepare('DELETE FROM messages WHERE id = ?').run(a.id);
    expect(unreadMark(db, CH, 0, SELF, opening.boundary!)).toMatchObject({ count: 1, firstId: b.id });
    putReadStates(db, [{ channelId: CH, ackId: b.id }], 'merge');
    expect(unreadMark(db, CH, 0, SELF, opening.boundary!)).toBeNull();
  });

  it('normalizes old or malformed settings and passes ids as data, including SQL-looking text', () => {
    for (const value of [undefined, null, true, {}, 'bot-a']) expect(normalizeCountedBots(value)).toEqual([]);
    expect(normalizeCountedBots(['', 1, null, A.id, A.id, B.id])).toEqual([A.id, B.id]);
    post(A);
    setSetting(db, SETTINGS_KEYS.countedBots, ['bad\'); DROP TABLE users; --']);
    expect(counts().newCount).toBe(0);
    setSetting(db, SETTINGS_KEYS.countedBots, [A.id, A.id, null]);
    expect(counts().newCount).toBe(1);
  });
});

describe('durable bot identity', () => {
  it('requests an archive refresh when member data alone identifies an existing author as a bot', () => {
    const user = { id: A.id, username: A.username, global_name: A.global_name };
    post(user);
    archive.upsertMembers('g1', [{ user }]);
    const changed = watchNameWrites(db);
    expect(changed()).toBeNull();
    archive.upsertMembers('g1', [{ user: { ...user, bot: true } }]);
    expect(changed()).toEqual({ guildIds: null });
    expect(counts().newCount).toBe(0);
    archive.upsertMembers('g1', [{ user: { ...user, bot: true } }]);
    expect(changed()).toBeNull();
  });
  it('keeps bots excluded after compression, pruning, and partial author updates', () => {
    const a = post({ ...A, avatar: 'avatar-hash' });
    db.prepare('UPDATE messages SET raw_json = ? WHERE id = ?').run(compressRawJson(JSON.stringify(a)), a.id);
    expect(unreadMark(db, CH, 0, SELF)).toBeNull();
    archive.applyUpdate({ id: a.id, channel_id: CH, author: { id: A.id, username: A.username } });
    upsertUser(db, { id: A.id, username: A.username });
    expect(counts()).toMatchObject({ newCount: 0, notableCount: 0 });
    expect(db.prepare('SELECT global_name, avatar FROM users WHERE id = ?').get(A.id)).toEqual({ global_name: 'Alpha', avatar: 'avatar-hash' });
    archive.applyUpdate({ id: a.id, channel_id: CH, author: { id: A.id, username: A.username, global_name: null, avatar: null } });
    expect(db.prepare('SELECT global_name, avatar FROM users WHERE id = ?').get(A.id)).toEqual({ global_name: null, avatar: null });
    db.prepare("UPDATE messages SET content = '', raw_json = NULL, pruned_at = 1 WHERE id = ?").run(a.id);
    expect(unreadMark(db, CH, 0, SELF)).toBeNull();
    expect(counts()).toMatchObject({ newCount: 0, notableCount: 0 });
    expect(archivedBots(db, SELF).map((bot) => bot.id)).toEqual([A.id]);
    setSetting(db, SETTINGS_KEYS.countedBots, [A.id]);
    expect(counts()).toMatchObject({ newCount: 1, notableCount: 1 });
    expect(unreadMark(db, CH, 0, SELF, a.id)?.count).toBe(1);
  });

  it('learns bot identity from partial gateway edits, including messages whose payloads were pruned', () => {
    const a = post({ id: A.id, username: A.username });
    const b = post({ id: B.id, username: B.username });
    expect(counts().newCount).toBe(2);
    archive.applyUpdate({ id: a.id, channel_id: CH, author: A });
    expect(counts().newCount).toBe(1);
    db.prepare("UPDATE messages SET content = '', raw_json = NULL, pruned_at = 1 WHERE id = ?").run(b.id);
    archive.applyUpdate({ id: b.id, channel_id: CH, author: B });
    expect(counts().newCount).toBe(0);
  });

  it('counts without parsing any payload, even damaged JSON or compressed bytes', () => {
    const a = post(A);
    const human = post({ id: 'human', username: 'human' });
    db.prepare('UPDATE messages SET raw_json = ? WHERE id = ?').run(Buffer.from('damaged compressed payload'), a.id);
    db.prepare("UPDATE messages SET raw_json = 'malformed' WHERE id = ?").run(human.id);
    let decodes = 0;
    db.function('msg_json', () => { decodes++; throw new Error('Counts must not decode payloads'); });
    expect(counts()).toMatchObject({ newCount: 1, notableCount: 1 });
    expect(unreadSnapshot(db, CH, 0, SELF).unread).toMatchObject({ count: 1, firstId: human.id });
    setSetting(db, SETTINGS_KEYS.countedBots, [A.id]);
    expect(unreadMark(db, CH, 0, SELF, a.id)?.count).toBe(2);
    expect(decodes).toBe(0);
  });
});

describe('bots available in Settings', () => {
  it('lists unique authors from kept history, respecting hidden references and the signed-in account’s DMs', () => {
    post(A);
    post(A);
    post(B, OTHER);
    const referenced: RawUser = { id: 'refs-hidden', username: 'refs', bot: true };
    post(referenced, CH, `hidden <#${OTHER}>`);
    const peer: RawUser = { id: 'private', username: 'private', bot: true };
    archive.upsertChannels('g1', [{ id: 'dm', name: 'dm', type: 1 }]);
    archive.setOptIn('dm', true);
    db.prepare("UPDATE channels SET account_id = 'other-owner' WHERE id = 'dm'").run();
    post(peer, 'dm');
    archive.setOptIn(CH, false);
    db.prepare('UPDATE channels SET hide_in_privacy = 1 WHERE id = ?').run(OTHER);
    setSetting(db, SETTINGS_KEYS.privacyMode, true);
    expect(archivedBots(db, SELF)).toEqual([{ id: A.id, name: 'Alpha', username: A.username }]);
    setSetting(db, SETTINGS_KEYS.privacyMode, false);
    expect(archivedBots(db, SELF).map((bot) => bot.id)).toEqual([A.id, B.id, referenced.id]);
    expect(archivedBots(db, 'other-owner').map((bot) => bot.id)).toContain(peer.id);
  });
});

describe('bot identity upgrade', () => {
  it('backfills plain and compressed legacy payloads, skips damage, and keeps classification across reopen', () => {
    const path = join(tempDir(), 'old.db');
    const old = new Database(path);
    applyMigrations(old, 0, migrationIndex(storedBotAuthors));
    old.prepare("INSERT INTO channels (id, name, kind) VALUES (?, 'channel', 0)").run(CH);
    const user = old.prepare('INSERT INTO users (id, username) VALUES (?, ?)');
    const message = old.prepare("INSERT INTO messages (id, channel_id, author_id, ts, content, raw_json) VALUES (?, ?, ?, 1, '', ?)");
    const values = [
      ['plain', JSON.stringify({ author: { bot: true } })],
      ['compressed', compressRawJson(JSON.stringify({ author: { bot: true } }))],
      ['damaged', 'malformed'],
      ['bad-blob', Buffer.from('broken')],
      ['null-json', 'null'],
      ['human', JSON.stringify({ author: {} })],
      ['pruned', null],
    ] as const;
    for (const [id, payload] of values) {
      user.run(id, id);
      message.run(id, CH, id, payload);
    }
    // Partial author payloads preserve previously stored bot evidence.
    message.run('partial', CH, 'plain', JSON.stringify({ author: { username: 'plain' } }));
    // Another damaged payload for a known bot must not prevent recovery from its good one.
    message.run('bad-first', CH, 'compressed', 'malformed');
    old.close();
    const upgraded = openDb(path);
    expect(upgraded.prepare('SELECT id FROM users WHERE bot = 1 ORDER BY id').pluck().all()).toEqual(['compressed', 'plain']);
    upgraded.close();
    const reopened = openDb(path);
    expect(reopened.prepare('SELECT id FROM users WHERE bot = 1 ORDER BY id').pluck().all()).toEqual(['compressed', 'plain']);
    reopened.close();
  });
});
