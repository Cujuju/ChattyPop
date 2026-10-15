// Contract tests for how re-fetches and edits change a stored message: newest version wins, every revision kept, links current.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MS_PER_MIN } from '@shared/units';
import type { Db } from '../src/core/db';
import type { Archive } from '../src/core/archive';
import { messagesByIds } from '../src/core/queries/messages';
import { textMessage } from '../src/core/queries/messageText';
import { searchMessages } from '../src/core/queries/search';
import { rawMessage, seedArchive, tempDb } from './helpers';
import { ARRIVAL, type TextMessage } from '../src/core/arrival';

const CH = '200000000000000001';
const T0 = Date.UTC(2026, 8, 1);
const iso = (ms: number): string => new Date(ms).toISOString();

let db: Db;
let archive: Archive;
let texts: TextMessage[];
beforeEach(() => {
  db = tempDb();
  texts = [];
  archive = seedArchive(db, [{ id: CH }], { onText: (m) => void texts.push(m) });
});
afterEach(() => vi.useRealTimers());

const stored = (id: string) => db.prepare('SELECT content, edited_ts AS editedTs FROM messages WHERE id = ?').get(id) as { content: string; editedTs: number | null };
const revisions = (id: string) => db.prepare('SELECT content FROM message_revisions WHERE message_id = ? ORDER BY seen_at').pluck().all(id);

describe('a re-fetch older than the stored edit', () => {
  it('leaves the newer gateway edit in place, text and edit time', () => {
    const m = rawMessage(CH, T0, 'old');
    archive.ingestMessages([m], ARRIVAL.gateway);
    archive.applyUpdate({ id: m.id, channel_id: CH, content: 'new', edited_timestamp: iso(T0 + MS_PER_MIN) });
    texts.length = 0;
    archive.ingestMessages([m], ARRIVAL.sync); // a history page fetched before the edit, delivered after it
    expect(stored(m.id)).toEqual({ content: 'new', editedTs: T0 + MS_PER_MIN });
    expect(revisions(m.id)).toEqual(['old']);
    expect(texts).toEqual([]);
  });

  it('ignores a gateway edit older than the stored one', () => {
    const m = rawMessage(CH, T0, 'v1');
    archive.ingestMessages([m], ARRIVAL.gateway);
    archive.applyUpdate({ id: m.id, channel_id: CH, content: 'v3', edited_timestamp: iso(T0 + 2 * MS_PER_MIN) });
    archive.applyUpdate({ id: m.id, channel_id: CH, content: 'v2', edited_timestamp: iso(T0 + MS_PER_MIN) });
    expect(stored(m.id)).toEqual({ content: 'v3', editedTs: T0 + 2 * MS_PER_MIN });
    expect(revisions(m.id)).toEqual(['v1']);
  });
});

describe('a re-fetch with unchanged text', () => {
  it('takes the current reactions, embeds and edit time, keeps gateway-only fields, and adds no revision', () => {
    const m = rawMessage(CH, T0, 'same', { reactions: [{ emoji: { id: null, name: '👍' }, count: 1 }], embeds: [], nonce: 'n1' });
    archive.ingestMessages([m], ARRIVAL.gateway);
    const { nonce: _gatewayOnly, ...fetched } = m;
    const later = { ...fetched, edited_timestamp: iso(T0 + MS_PER_MIN), reactions: [{ emoji: { id: null, name: '👍' }, count: 5 }], embeds: [{ type: 'rich', title: 'Card' }] };
    texts.length = 0;
    archive.ingestMessages([later], ARRIVAL.sync);
    const [shown] = messagesByIds(db, [m.id]);
    expect(shown).toMatchObject({ content: 'same', editedTs: T0 + MS_PER_MIN, nonce: 'n1', revisions: [] });
    expect(shown!.reactions.map((r) => r.count)).toEqual([5]);
    expect(shown!.embeds.map((e) => e.title)).toEqual(['Card']);
    expect(texts).toEqual([]);
    // Discord leaves `reactions` out once none remain.
    const { reactions: _none, ...bare } = later;
    archive.ingestMessages([bare], ARRIVAL.sync);
    expect(messagesByIds(db, [m.id])[0]!.reactions).toEqual([]);
  });
});

describe('revisions', () => {
  it('keeps every prior text when edits arrive within one millisecond', () => {
    const m = rawMessage(CH, T0, 'v1');
    archive.ingestMessages([m], ARRIVAL.gateway);
    vi.useFakeTimers({ now: T0 + MS_PER_MIN, toFake: ['Date'] });
    archive.applyUpdate({ id: m.id, channel_id: CH, content: 'v2', edited_timestamp: iso(T0 + 1) });
    archive.applyUpdate({ id: m.id, channel_id: CH, content: 'v3', edited_timestamp: iso(T0 + 2) });
    expect(revisions(m.id)).toEqual(['v1', 'v2']);
    expect(stored(m.id).content).toBe('v3');
  });
});

describe('links an edit removes', () => {
  it('leave the message: its linked text, search and shares, while another message sharing the link keeps it', () => {
    const removed = 'https://example.com/removed';
    const card = { type: 'link', url: removed, title: 'Uniqueremovedlinktitle' };
    const m = rawMessage(CH, T0, `see ${removed}`, { embeds: [card] });
    const other = rawMessage(CH, T0 + 1, `also ${removed}`, { embeds: [card] });
    archive.ingestMessages([m, other], ARRIVAL.gateway);
    archive.applyUpdate({ id: m.id, channel_id: CH, content: 'removed the link, see https://example.com/kept', edited_timestamp: iso(T0 + MS_PER_MIN), embeds: [] });
    expect(textMessage(db, m.id)!.linked).toBe('');
    expect(searchMessages(db, 'Uniqueremovedlinktitle', 10, 'relevance').map((h) => h.messageId)).toEqual([other.id]);
    const links = (id: string) => db.prepare('SELECT l.url FROM message_links ml JOIN links l ON l.id = ml.link_id WHERE ml.message_id = ?').pluck().all(id);
    expect(links(m.id)).toEqual(['https://example.com/kept']);
    expect(links(other.id)).toEqual([removed]);
  });
});
