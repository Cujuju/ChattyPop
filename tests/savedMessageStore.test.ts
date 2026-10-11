import { describe, expect, it, vi } from 'vitest';
import type { SavedBookmarkPage, SavedIndex, SavedMessage } from '@shared/savedMessages';
// Dynamic path keeps node's typecheck from following browser-only store imports.
const path = '../src/renderer/src/state/savedMessageStore';
const { SavedMessageStore } = await import(path) as typeof import('../src/renderer/src/state/savedMessageStore');
const row = (id = '200000000000000001', savedAt = '2026-10-01T12:00:00Z'): SavedMessage => ({ channelId: '100000000000000001', messageId: id, guildId: null, savedAt, dueAt: null, authorName: 'Alice', channelName: '#general', summary: 'hello', available: true });
const index = (session = 'a', revision = 1): SavedIndex => ({ session, revision, pageEpoch: 0, reminders: [], bookmarkIds: [row().messageId], writableChannelIds: [row().channelId] });
const page = (session = 'a', revision = 1): SavedBookmarkPage => ({ session, revision, pageEpoch: 0, bookmarks: [row()], hasMore: true, nextBefore: row().savedAt });
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { resolve, promise }; };
describe('saved-message renderer fencing', () => {
  it('retains pagination through an index-only update, remount and subsequent load-more', async () => {
    const load = vi.fn(async () => index()), pages = vi.fn(async () => page()), store = new SavedMessageStore({ savedMessages: load, savedBookmarks: pages }, () => undefined);
    await store.refresh(); const cursor = store.state.nextBefore;
    store.invalidate('a', 2, false, 0); load.mockResolvedValue(index('a', 2)); pages.mockResolvedValue(page('a', 2));
    await store.refresh(false, false); expect(store.state.nextBefore).toBe(cursor); expect(store.state.hasMore).toBe(true);
    await store.refresh(); expect(store.state.nextBefore).toBe(cursor); expect(store.state.hasMore).toBe(true);
    pages.mockResolvedValueOnce({ ...page('a', 2), bookmarks: [], hasMore: false }); await store.loadMore();
    expect(pages).toHaveBeenLastCalledWith({ session: 'a', pageEpoch: 0, before: cursor }); expect(store.state.stale).toBe(false);
  });
  it('requires a read since the last reset even when an old read failed or is still pending', async () => {
    const pending = deferred<SavedIndex>(), load = vi.fn(async () => pending.promise), store = new SavedMessageStore({ savedMessages: load, savedBookmarks: async () => page() }, () => undefined);
    store.invalidate('a', 1, true); expect(store.hasReadSinceReset).toBe(false);
    const read = store.refresh(false, false); expect(store.hasReadSinceReset).toBe(true);
    store.invalidate('b', 2, true); expect(store.hasReadSinceReset).toBe(false);
    store.invalidate('b', 3, false); expect(store.hasReadSinceReset).toBe(false);
    pending.resolve(index()); await read; expect(store.hasReadSinceReset).toBe(false);
    load.mockRejectedValueOnce(new Error('Conflict')); await store.refresh(); expect(store.hasReadSinceReset).toBe(true);
    store.invalidate('b', 4, false); expect(store.hasReadSinceReset).toBe(true);
    store.clear(); expect(store.hasReadSinceReset).toBe(false);
  });
  it('does not resurrect removed bookmarks during an index-only event refresh', async () => {
    const load = vi.fn(async () => index()), store = new SavedMessageStore({ savedMessages: load, savedBookmarks: async () => page() }, () => undefined);
    await store.refresh(); store.invalidate('a', 2, false);
    load.mockResolvedValueOnce({ ...index('a', 2), bookmarkIds: [] }); await store.refresh(false, false);
    expect(store.state.bookmarkIds).toEqual([]); expect(store.state.bookmarks).toEqual([]); expect(store.state.stale).toBe(false);
  });
  it('upgrades a pending menu-only read when the panel mounts and settles with one page request', async () => {
    const pending = deferred<SavedIndex>(), savedBookmarks = vi.fn(async () => page()), load = vi.fn(async (_force?: boolean) => pending.promise);
    const store = new SavedMessageStore({ savedMessages: load, savedBookmarks }, () => undefined);
    const menu = store.refresh(false, false), panel = store.refresh(false, true); expect(menu).toBe(panel);
    pending.resolve(index()); await panel; expect(store.state.bookmarksLoaded).toBe(true); expect(store.state.bookmarks).toHaveLength(1); expect(savedBookmarks).toHaveBeenCalledTimes(1);
    expect(load.mock.calls.every(([force]) => !force)).toBe(true);
  });
  it('adopts a new main-process session with a lower revision and discards delayed older reads', async () => {
    const savedMessages = vi.fn(async () => index('old', 100)), savedBookmarks = vi.fn(async () => page('old', 100));
    const store = new SavedMessageStore({ savedMessages, savedBookmarks }, () => undefined); await store.refresh();
    savedMessages.mockResolvedValueOnce(index('new', 1)); savedBookmarks.mockResolvedValueOnce(page('new', 1)); await store.refresh();
    expect(store.state.session).toBe('new'); expect(store.state.revision).toBe(1); expect(store.state.stale).toBe(false);
    store.invalidate('third', 0, true); expect(store.state.session).toBe('third'); expect(store.state.bookmarks).toEqual([]);
  });
  it('menu initialization reads only the index, while explicit Refresh requests fresh native pages', async () => {
    const savedMessages = vi.fn(async () => index()), savedBookmarks = vi.fn(async () => page());
    const store = new SavedMessageStore({ savedMessages, savedBookmarks }, () => undefined);
    await store.refresh(false, false); expect(savedBookmarks).not.toHaveBeenCalled(); expect(store.state.bookmarksLoaded).toBe(false);
    await store.refresh(true); expect(savedMessages).toHaveBeenLastCalledWith(true); expect(savedBookmarks).toHaveBeenLastCalledWith({ session: 'a', pageEpoch: 0, refresh: true });
    const first = store.state.bookmarks[0]; await store.refresh(); expect(store.state.bookmarks[0]).toBe(first);
  });
  it('atomically loads native index and page, and uses the native cursor across pages hidden by privacy', async () => {
    const savedBookmarks = vi.fn(async () => page());
    const store = new SavedMessageStore({ savedMessages: async () => index(), savedBookmarks }, () => undefined);
    await store.refresh();
    savedBookmarks.mockResolvedValueOnce({ ...page(), bookmarks: [], nextBefore: '2026-09-30T12:00:00Z' });
    await store.loadMore();
    expect(store.state.bookmarks).toHaveLength(1);
    expect(store.state.nextBefore).toBe('2026-09-30T12:00:00Z');
    savedBookmarks.mockResolvedValueOnce({ ...page(), bookmarks: [row('200000000000000002', '2026-09-29T12:00:00Z')], hasMore: false });
    await store.loadMore();
    expect(savedBookmarks).toHaveBeenLastCalledWith({ session: 'a', pageEpoch: 0, before: '2026-09-30T12:00:00Z' });
    expect(store.state.bookmarks).toHaveLength(2);
  });
  it('ignores delayed reads after account changes or privacy reset without leaking the old rows', async () => {
    const pending = deferred<SavedBookmarkPage>();
    const api = { savedMessages: async () => index(), savedBookmarks: () => pending.promise };
    const store = new SavedMessageStore(api, () => undefined);
    const refresh = store.refresh(); await Promise.resolve();
    store.invalidate('b', 2, true); pending.resolve(page()); await refresh;
    expect(store.state.session).toBe('b'); expect(store.state.bookmarks).toEqual([]);
    const store2 = new SavedMessageStore({ savedMessages: async () => index(), savedBookmarks: async () => page() }, () => undefined);
    await store2.refresh(); store2.clear();
    expect(store2.state.bookmarks).toEqual([]);
  });
  it('retains prior visible content on refresh failure but refuses mutations/pagination until refreshed', async () => {
    const load = vi.fn(async () => index()), store = new SavedMessageStore({ savedMessages: load, savedBookmarks: async () => page() }, () => undefined);
    await store.refresh(); load.mockRejectedValueOnce(new Error('Offline')); await store.refresh();
    expect(store.state.bookmarks).toHaveLength(1); expect(store.state.error).toBe('Offline'); expect(store.state.stale).toBe(true);
  });
  it('rejects mixed revisions and invalidates delayed load-more results', async () => {
    const load = vi.fn(async () => page()), store = new SavedMessageStore({ savedMessages: async () => index(), savedBookmarks: load }, () => undefined);
    load.mockResolvedValueOnce(page('a', 2)); await store.refresh();
    expect(store.state.bookmarks).toEqual([]); expect(store.state.error).toMatch(/changed/);
    await store.refresh();
    const pending = deferred<SavedBookmarkPage>(); load.mockReturnValueOnce(pending.promise);
    const more = store.loadMore(); store.invalidate('a', 2, true); pending.resolve(page()); await more;
    expect(store.state.bookmarks).toEqual([]);
  });
  it('decodes the legacy full list without an extra bookmarks request and coalesces concurrent refreshes', async () => {
    const pending = deferred<SavedIndex>(), savedBookmarks = vi.fn(async () => page());
    const load = vi.fn(async () => pending.promise), store = new SavedMessageStore({ savedMessages: load, savedBookmarks }, () => undefined);
    const a = store.refresh(), b = store.refresh();
    expect(a).toBe(b); pending.resolve({ ...index(), legacyBookmarks: [row()] }); await a;
    expect(savedBookmarks).not.toHaveBeenCalled(); expect(store.state.bookmarks).toHaveLength(1);
  });
});
