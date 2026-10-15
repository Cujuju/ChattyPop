// Contract tests for how re-fetches and edits change a stored message: newest version wins, every revision kept, links current.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MS_PER_MIN } from '@shared/units';
import type { Db } from '../src/core/db';
import type { Archive } from '../src/core/archive';
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
