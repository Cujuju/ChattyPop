// Contract: after a jump the Archive's window can stop short of the newest message; it pages newer messages in
// (`after`), oldest first, without gaps or repeats, until it reaches the newest.
import { beforeEach, describe, expect, it } from 'vitest';
import { MS_PER_S } from '@shared/units';
import type { Db } from '../src/core/db';
import { messagePage } from '../src/core/queries/messages';
import { ARRIVAL } from '../src/core/arrival';
import { rawMessage, seedArchive, tempDb } from './helpers';
import { messageBefore } from '@shared/messageOrder';
import { createPagedList } from '../src/renderer/src/state/paged';

const CHANNEL = '200000000000000001';
let db: Db;
const at = (n: number): number => Date.now() - 1000 * MS_PER_S + n * MS_PER_S;

beforeEach(() => {
  db = tempDb();
  const archive = seedArchive(db, [{ id: CHANNEL, name: 'general', guildId: '100000000000000001' }]);
  archive.ingestMessages(Array.from({ length: 25 }, (_, i) => rawMessage(CHANNEL, at(i), `m${i}`)), ARRIVAL.gateway);
});

describe('archive paging toward the newest', () => {
  it('reads the messages after one, oldest first', () => {
    const all = messagePage(db, { channelId: CHANNEL, limit: 100 });
    const page = messagePage(db, { channelId: CHANNEL, limit: 5, after: all[10]!.id });
    expect(page.map((m) => m.content)).toEqual(['m11', 'm12', 'm13', 'm14', 'm15']);
  });

  it('pages from a window around an older message to the newest without gaps or repeats', () => {
    const all = messagePage(db, { channelId: CHANNEL, limit: 100 });
    let window = messagePage(db, { channelId: CHANNEL, limit: 6, around: all[5]!.id });
    for (let guard = 0; guard < 20; guard++) {
      const page = messagePage(db, { channelId: CHANNEL, limit: 6, after: window.at(-1)!.id });
      window = [...window, ...page];
      if (page.length < 6) break;
    }
    const contents = window.map((m) => m.content);
    expect(contents.at(-1)).toBe('m24');
    expect(new Set(contents).size).toBe(contents.length);
    const first = Number(contents[0]!.slice(1));
    expect(contents).toEqual(Array.from({ length: 25 - first }, (_, i) => `m${first + i}`));
  });

  it('reads nothing after the newest, or after an unknown id', () => {
    const all = messagePage(db, { channelId: CHANNEL, limit: 100 });
    expect(messagePage(db, { channelId: CHANNEL, limit: 5, after: all.at(-1)!.id })).toEqual([]);
    expect(messagePage(db, { channelId: CHANNEL, limit: 5, after: '999' })).toEqual([]);
  });

  it('orders messages sharing a timestamp by id as a number, before and after alike', () => {
    const ts = at(100);
    const ids = ['9', '10', '99', '100'];
    const archive = seedArchive(db, [{ id: CHANNEL, name: 'general', guildId: '100000000000000001' }]);
    archive.ingestMessages(ids.map((id) => rawMessage(CHANNEL, ts, `t${id}`, { id })), ARRIVAL.gateway);
    const tie = (q: { after?: string; before?: string }) => messagePage(db, { channelId: CHANNEL, limit: 10, ...q }).map((m) => m.content).filter((c) => c.startsWith('t'));
    expect(tie({ after: '9' })).toEqual(['t10', 't99', 't100']);
    expect(tie({ after: '99' })).toEqual(['t100']);
    expect(tie({ before: '100' })).toEqual(['t9', 't10', 't99']);
    expect(tie({ before: '10' })).toEqual(['t9']);
  });
});

describe('message order', () => {
  it('is timestamp, then id by length, then digits', () => {
    expect(messageBefore({ ts: 1, id: '99' }, { ts: 2, id: '1' })).toBe(true);
    expect(messageBefore({ ts: 1, id: '99' }, { ts: 1, id: '100' })).toBe(true);
    expect(messageBefore({ ts: 1, id: '50' }, { ts: 1, id: '51' })).toBe(true);
    expect(messageBefore({ ts: 1, id: '51' }, { ts: 1, id: '51' })).toBe(false);
  });
});

describe('paged list directions', () => {
  type Item = { id: number };
  const deferred = () => {
    let resolve!: (v: Item[]) => void;
    return { promise: new Promise<Item[]>((r) => (resolve = r)), resolve };
  };

  it('a page of older rows in flight does not hold up newer ones, or the reverse', async () => {
    const older = deferred();
    const newer = deferred();
    const list = createPagedList<Item>(2, () => older.promise, () => newer.promise);
    await list.reload(async () => ({ items: [{ id: 10 }, { id: 11 }], reachedStart: false }));
    const o = list.loadOlder();
    const n = list.loadNewer();
    expect(list.state.loading).toBe(true);
    newer.resolve([{ id: 12 }]);
    expect(await n).toBe(1);
    older.resolve([{ id: 8 }, { id: 9 }]);
    expect(await o).toBe(2);
    expect(list.state.items.map((i) => i.id)).toEqual([8, 9, 10, 11, 12]);
    expect(list.state.loading).toBe(false);
  });

  it('newer pages skip rows a refresh already added, and a reload drops a page in flight', async () => {
    const newer = deferred();
    const list = createPagedList<Item>(2, async () => [], () => newer.promise);
    await list.reload(async () => ({ items: [{ id: 1 }], reachedStart: true }));
    const n = list.loadNewer();
    list.setItems([{ id: 1 }, { id: 2 }]);
    newer.resolve([{ id: 2 }, { id: 3 }]);
    expect(await n).toBe(2);
    expect(list.state.items.map((i) => i.id)).toEqual([1, 2, 3]);
    const stale = deferred();
    const list2 = createPagedList<Item>(2, async () => [], () => stale.promise);
    await list2.reload(async () => ({ items: [{ id: 1 }], reachedStart: true }));
    const late = list2.loadNewer();
    await list2.reload(async () => ({ items: [{ id: 7 }], reachedStart: true }));
    stale.resolve([{ id: 2 }]);
    expect(await late).toBeNull();
    expect(list2.state.items.map((i) => i.id)).toEqual([7]);
  });
});
