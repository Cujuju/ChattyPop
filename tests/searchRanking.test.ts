// Search shows full-text results first, then delayed ranking. Only the latest query response applies; null or failed ranking preserves full-text order.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchHit } from '@shared/contract';
import type { SearchSort } from '@shared/searchQuery';

/** A core call the test answers when it chooses. */
interface Pending<T> {
  args: unknown[];
  resolve(value: T): void;
  reject(err: unknown): void;
}

const env = vi.hoisted(() => ({
  searches: [] as Pending<SearchHit[]>[],
  ranks: [] as Pending<SearchHit[] | null>[],
}));

const pending = <T>(list: Pending<T>[]) => (...args: unknown[]) => new Promise<T>((resolve, reject) => list.push({ args, resolve, reject }));
vi.mock('@/api', () => ({ api: { core: { searchMessages: pending(env.searches), rankSearch: pending(env.ranks) } } }));
vi.mock('../src/renderer/src/state/events', () => ({ onAppEvent: () => undefined }));
vi.mock('@plugin-sdk/renderer/settings', async () => {
  const { createSignal } = await import('solid-js');
  return { createSetting: <T,>(_key: string, fallback: T) => createSignal(fallback) };
});

// A renderer module: imported by path so the node type-check doesn't follow it.
const statePath = '../src/renderer/src/state/search';
const { querySearch, searchHits, setSearchSort } = (await import(statePath)) as {
  querySearch(text: string): void;
  searchHits(): SearchHit[];
  setSearchSort(sort: SearchSort): void;
};

/** The search store's pauses (typing, then the longer one before rankers run) and its result limit. */
const QUERY_DEBOUNCE_MS = 150;
const RANK_PAUSE_MS = 1000;
const RESULT_LIMIT = 30;

const hit = (id: string): SearchHit => ({ messageId: id, channelId: 'c', channelName: 'c', authorName: 'a', ts: 1, snippet: id, mentions: {} });
const FULL_TEXT = ['a', 'b', 'c'].map(hit);
const RANKED = ['c', 'a', 'b'].map((id) => ({ ...hit(id), relevance: 0.9 }));
const shown = (): string[] => searchHits().map((h) => h.messageId);

/** Types `text` and answers its full-text search; the rankers' pause hasn't passed. */
async function searchFor(text: string): Promise<void> {
  querySearch(text);
  await vi.advanceTimersByTimeAsync(QUERY_DEBOUNCE_MS);
  env.searches.shift()!.resolve(FULL_TEXT);
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  setSearchSort('relevance');
  env.searches.length = 0;
  env.ranks.length = 0;
});
afterEach(() => {
  querySearch('');
  vi.useRealTimers();
});

describe('search ranking', () => {
  it('shows the full-text order first, then asks the rankers after the pause and shows their order', async () => {
    await searchFor('plans');
    expect(shown()).toEqual(['a', 'b', 'c']);
    expect(env.ranks).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(RANK_PAUSE_MS);
    expect(env.ranks.map((r) => r.args)).toEqual([['plans', FULL_TEXT]]);
    env.ranks.shift()!.resolve(RANKED);
    await vi.advanceTimersByTimeAsync(0);
    expect(shown()).toEqual(['c', 'a', 'b']);
  });

  it('drops a ranking answered after a newer query, a cleared one included', async () => {
    await searchFor('plans');
    await vi.advanceTimersByTimeAsync(RANK_PAUSE_MS);
    const stale = env.ranks.shift()!;
    querySearch('');
    stale.resolve(RANKED);
    await vi.advanceTimersByTimeAsync(0);
    expect(shown()).toEqual([]);

    await searchFor('plans');
    await vi.advanceTimersByTimeAsync(RANK_PAUSE_MS);
    const older = env.ranks.shift()!;
    await searchFor('plans today');
    older.resolve(RANKED);
    await vi.advanceTimersByTimeAsync(0);
    expect(shown()).toEqual(['a', 'b', 'c']);
  });

  it('keeps the full-text order when the rankers change nothing or fail', async () => {
    await searchFor('plans');
    await vi.advanceTimersByTimeAsync(RANK_PAUSE_MS);
    env.ranks.shift()!.resolve(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(shown()).toEqual(['a', 'b', 'c']);

    await searchFor('plans again');
    await vi.advanceTimersByTimeAsync(RANK_PAUSE_MS);
    env.ranks.shift()!.reject(new Error('core failed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(shown()).toEqual(['a', 'b', 'c']);
  });

  it('asks no ranker for fewer than two results or a query typed over before the pause', async () => {
    querySearch('one');
    await vi.advanceTimersByTimeAsync(QUERY_DEBOUNCE_MS);
    env.searches.shift()!.resolve([hit('a')]);
    await vi.advanceTimersByTimeAsync(RANK_PAUSE_MS);
    await searchFor('plans');
    querySearch('plans t');
    await vi.advanceTimersByTimeAsync(RANK_PAUSE_MS);
    expect(env.ranks).toHaveLength(0);
  });

  it('asks in the chosen order, searches again when it changes, and ranks only by relevance', async () => {
    setSearchSort('newest');
    await searchFor('plans');
    await vi.advanceTimersByTimeAsync(RANK_PAUSE_MS);
    expect(env.ranks).toHaveLength(0);
    setSearchSort('oldest');
    await vi.advanceTimersByTimeAsync(QUERY_DEBOUNCE_MS);
    expect(env.searches.map((s) => s.args)).toEqual([['plans', RESULT_LIMIT, 'oldest']]);
  });
});
