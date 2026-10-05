import { beforeEach, describe, expect, it } from 'vitest';
import { snowflakeFromMs } from '@shared/discord';
import { ATTACHMENT_FLAG, isSpoiler } from '@shared/media';
import { MS_PER_MIN } from '@shared/units';
import type { Db } from '../src/core/db';
import type { Archive } from '../src/core/archive';
import { directory } from '../src/core/queries/directory';
import { rawMessage, seedArchive, tempDb } from './helpers';
import { ARRIVAL } from '../src/core/arrival';

const GUILD = '100000000000000001';
const GENERAL = '200000000000000001';
const OTHER = '200000000000000002';
const T0 = Date.UTC(2026, 8, 1);
const SELF = '100000000000000009';

let db: Db;
let archive: Archive;
beforeEach(() => {
  db = tempDb();
  archive = seedArchive(db, [{ id: GENERAL }, { id: OTHER, optIn: false }], { guilds: [{ id: GUILD, name: 'Guild' }] });
});

const row = (id: string) =>
  db.prepare('SELECT content, deleted_at, pruned_at FROM messages WHERE id = ?').get(id) as {
    content: string;
    deleted_at: number | null;
    pruned_at: number | null;
  };

describe('archive: edits and deletes are never lost', () => {
  it('keeps the prior text as a revision when content changes', () => {
    const m = rawMessage(GENERAL, T0, 'first');
    archive.ingestMessages([m], ARRIVAL.gateway);
    const r = archive.ingestMessages([{ ...m, content: 'second', edited_timestamp: new Date(T0 + MS_PER_MIN).toISOString() }], ARRIVAL.gateway);
    expect(r.edited).toBe(1);
    expect(row(m.id).content).toBe('second');
    expect(db.prepare('SELECT content FROM message_revisions WHERE message_id = ?').all(m.id)).toEqual([{ content: 'first' }]);
  });

  it('merges a partial update (no content) without touching the text', () => {
    const m = rawMessage(GENERAL, T0, 'hello');
    archive.ingestMessages([m], ARRIVAL.gateway);
    archive.applyUpdate({ id: m.id, channel_id: GENERAL, embeds: [{ url: 'https://example.com' }] });
    expect(row(m.id).content).toBe('hello');
    const raw = JSON.parse(db.prepare('SELECT raw_json FROM messages WHERE id = ?').pluck().get(m.id) as string) as { embeds: unknown[] };
    expect(raw.embeds).toHaveLength(1);
  });

  it('soft-deletes: the original stays readable', () => {
    const m = rawMessage(GENERAL, T0, 'keep me');
    archive.ingestMessages([m], ARRIVAL.gateway);
    archive.markDeleted(GENERAL, m.id, T0 + MS_PER_MIN);
    expect(row(m.id)).toMatchObject({ content: 'keep me', deleted_at: T0 + MS_PER_MIN });
  });

  it('skips channels that are not opted in', () => {
    expect(archive.ingestMessages([rawMessage(OTHER, T0, 'x')], ARRIVAL.gateway).skipped).toBe(1);
  });

  it('keeps an attachment an edit removed, marked; takes alt text and the spoiler flag; a partial update removes nothing', () => {
    const file = (id: string, filename: string, description?: string, flags?: number) => ({ id, filename, url: `https://cdn.discordapp.com/${id}`, description, flags });
    const attachments = () =>
      db.prepare('SELECT id, filename, description, flags, removed_at IS NOT NULL AS removed FROM attachments ORDER BY id').all() as {
        id: string;
        filename: string;
        description: string | null;
        flags: number | null;
        removed: number;
      }[];
    const m = { ...rawMessage(GENERAL, T0, 'two clips'), attachments: [file('a1', 'one.mov'), file('a2', 'two.mov')] };
    archive.ingestMessages([m], ARRIVAL.gateway);
    archive.applyUpdate({ id: m.id, channel_id: GENERAL, embeds: [] });
    expect(attachments().map((a) => a.removed)).toEqual([0, 0]);
    archive.applyUpdate({ id: m.id, channel_id: GENERAL, attachments: [file('a2', 'two.mov', 'a chart', ATTACHMENT_FLAG.spoiler)] });
    expect(attachments()).toEqual([
      { id: 'a1', filename: 'one.mov', description: null, flags: null, removed: 1 },
      { id: 'a2', filename: 'two.mov', description: 'a chart', flags: ATTACHMENT_FLAG.spoiler, removed: 0 },
    ]);
    expect(isSpoiler(attachments()[1]!)).toBe(true);
    // A re-fetch with the same text still updates the stored payload, which re-derivation reads.
    archive.ingestMessages([{ ...m, attachments: [file('a2', 'two.mov', 'a chart')] }], ARRIVAL.sync);
    const raw = JSON.parse(db.prepare('SELECT raw_json FROM messages WHERE id = ?').pluck().get(m.id) as string) as { attachments: { flags?: number }[] };
    expect(raw.attachments.map((a) => a.flags)).toEqual([undefined]);
    // An older copy never brings a removed attachment back.
    archive.ingestMessages([m], ARRIVAL.sync);
    expect(attachments()[0]!.removed).toBe(1);
  });

  it('never restores text that retention pruned', () => {
    const m = rawMessage(GENERAL, T0, 'secret');
    archive.ingestMessages([m], ARRIVAL.gateway);
    db.prepare("UPDATE messages SET content = '', raw_json = NULL, pruned_at = 1 WHERE id = ?").run(m.id);
    archive.ingestMessages([m], ARRIVAL.gateway);
    archive.applyUpdate({ ...m, content: 'secret again' });
    expect(row(m.id)).toMatchObject({ content: '', pruned_at: 1 });
  });
});

describe('archive: sync cursors', () => {
  it('extend only from sync pages, never from live messages', () => {
    const page = [rawMessage(GENERAL, T0, 'a'), rawMessage(GENERAL, T0 + MS_PER_MIN, 'b')];
    archive.ingestSyncPage(GENERAL, page, 'older', false);
    archive.ingestMessages([rawMessage(GENERAL, T0 + 10 * MS_PER_MIN, 'live')], ARRIVAL.gateway);
    const s = archive.syncState(GENERAL);
    expect(s).toMatchObject({ oldestId: page[0]!.id, newestId: page[1]!.id, count: 3, backfillComplete: false });
  });

  it('marks backfill complete when an older page reaches the start', () => {
    archive.ingestSyncPage(GENERAL, [rawMessage(GENERAL, T0, 'a')], 'older', true);
    expect(archive.syncState(GENERAL).backfillComplete).toBe(true);
  });
});

describe('archive: threads follow their parent', () => {
  const thread = (id: string, parent: string, lastMs: number | null) => ({
    id,
    name: `t-${id}`,
    type: 11,
    parent_id: parent,
    last_message_id: lastMs === null ? null : snowflakeFromMs(lastMs),
  });

  it('stores threads of archived channels only, and reports those with messages to sync', () => {
    const stale = archive.upsertThreads([thread('300000000000000001', GENERAL, T0), thread('300000000000000002', OTHER, T0)], 0);
    expect(stale).toEqual(['300000000000000001']);
    expect(archive.isOptedIn('300000000000000001')).toBe(true);
    expect(archive.channelInfo('300000000000000002')).toBeNull();
  });

  it('reports a synced thread again only when it has newer messages', () => {
    const id = '300000000000000001';
    archive.upsertThreads([thread(id, GENERAL, T0)], 0);
    archive.ingestSyncPage(id, [rawMessage(id, T0, 'x')], 'older', true);
    expect(archive.upsertThreads([thread(id, GENERAL, T0)], 0)).toEqual([]);
    expect(archive.upsertThreads([thread(id, GENERAL, T0 + MS_PER_MIN)], 0)).toEqual([id]);
  });

  it('opting the parent out opts its threads out; sync lists channels, not threads', () => {
    const id = '300000000000000001';
    archive.upsertThreads([thread(id, GENERAL, T0)], 0);
    expect(archive.optedInChannels(null)).toEqual([GENERAL]);
    archive.setOptIn(GENERAL, false);
    expect(archive.isOptedIn(id)).toBe(false);
  });
});

describe('archive: direct messages', () => {
  it('lists DMs first, newest conversation first, named by recipients', () => {
    archive.replacePrivateChannels(SELF, [
      { id: '400000000000000001', type: 1, recipients: [{ id: 'u2', username: 'bob', global_name: 'Bob' }], last_message_id: snowflakeFromMs(T0) },
      {
        id: '400000000000000002',
        type: 3,
        name: null,
        recipients: [
          { id: 'u3', username: 'cy' },
          { id: 'u4', username: 'di' },
        ],
        last_message_id: snowflakeFromMs(T0 + MS_PER_MIN),
      },
      { id: '400000000000000003', type: 0 },
    ], false, T0);
    const [dms, guild] = directory(db, 0, SELF);
    expect(dms!.id).toBe('@me');
    expect(dms!.channels.map((c) => c.name)).toEqual(['cy, di', 'Bob']);
    expect(guild!.id).toBe(GUILD);
  });

  it("names a one-to-one DM's other person from the DM list, before any message is stored", () => {
    archive.replacePrivateChannels(SELF, [
      { id: '400000000000000001', type: 1, recipients: [{ id: 'u2', username: 'bob', avatar: 'a1b2' }], last_message_id: snowflakeFromMs(T0) },
      { id: '400000000000000002', type: 3, name: 'crew', recipients: [{ id: 'u3', username: 'cy' }], last_message_id: snowflakeFromMs(T0) },
    ], false, T0);
    const channels = directory(db, 0, SELF)[0]!.channels;
    expect(channels.find((c) => c.name === 'bob')?.peer).toEqual({ id: 'u2', avatar: 'a1b2' });
    // A group DM has no one other person.
    expect(channels.find((c) => c.name === 'crew')?.peer).toBeNull();
  });

  it("keeps a group DM's own icon from the DM list, and clears it when the group drops it", () => {
    const group = { id: '400000000000000002', type: 3, name: 'crew', recipients: [{ id: 'u3', username: 'cy' }], last_message_id: snowflakeFromMs(T0) };
    const icon = () => directory(db, 0, SELF)[0]!.channels[0]!.icon;
    archive.replacePrivateChannels(SELF, [{ ...group, icon: 'c0ffee' }], false, T0);
    expect(icon()).toBe('c0ffee');
    archive.replacePrivateChannels(SELF, [{ ...group, icon: null }], false, T0);
    expect(icon()).toBeNull();
  });

  it('falls back to a DM’s newest sender who is not the owner when no recipient was kept', () => {
    const dm = '400000000000000001';
    // A delta without recipients: no one is kept for it.
    archive.upsertPrivateChannel('me', { id: dm, type: 1, last_message_id: snowflakeFromMs(T0) }, true);
    archive.setOptIn(dm, true);
    const bob = { id: 'u2', username: 'bob', avatar: 'a1b2' };
    archive.ingestMessages([rawMessage(dm, T0, 'hi', { author: bob }), rawMessage(dm, T0 + MS_PER_MIN, 'hey', { author: { id: 'me', username: 'me' } })], ARRIVAL.sync);
    expect(directory(db, 0, 'me')[0]!.channels[0]!.peer).toEqual({ id: 'u2', avatar: 'a1b2' });
  });
  it('always offers the DM group, even before any DM is stored', () => {
    expect(directory(db, 0)[0]).toMatchObject({ id: '@me', channels: [] });
  });
});

describe('archive: startup re-check', () => {
  it('marks deleted only the stored messages missing from the re-fetched window', () => {
    const before = rawMessage(GENERAL, T0 - MS_PER_MIN, 'outside, older');
    const kept = rawMessage(GENERAL, T0, 'kept');
    const gone = rawMessage(GENERAL, T0 + MS_PER_MIN, 'deleted while closed');
    const edge = rawMessage(GENERAL, T0 + 2 * MS_PER_MIN, 'kept too');
    const after = rawMessage(GENERAL, T0 + 3 * MS_PER_MIN, 'outside, newer');
    archive.ingestMessages([before, kept, gone, edge, after], ARRIVAL.gateway);
    expect(archive.reconcileDeletes(GENERAL, [kept.id, edge.id], T0, T0 + 2 * MS_PER_MIN, T0 + 10 * MS_PER_MIN)).toBe(1);
    expect(row(gone.id).deleted_at).toBe(T0 + 10 * MS_PER_MIN);
    for (const m of [before, kept, edge, after]) expect(row(m.id).deleted_at).toBeNull();
  });
});
