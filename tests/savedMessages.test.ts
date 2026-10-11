import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscordHttpError } from '@shared/discord';
import { SAVED_BOOKMARK_PAGE_SIZE, SAVED_LIMIT_CODE, SAVED_REFRESH_INTERVAL_MS, type SavedMessage } from '@shared/savedMessages';
import { decodeSavedIndex, decodeSavedMessage, decodeSavedPage, SavedMessages } from '../src/main/discord/savedMessages';
import type { DiscordClient, RequestOptions, WriteOptions } from '../src/main/discord/client';
import { HeaderCapture } from '../src/main/discord/capture';

vi.mock('electron', () => ({ app: { getPath: () => '' } }));
vi.mock('../src/main/diagnostics', () => ({ diag: () => undefined, redactIds: (s: string) => s }));
const { DiscordApi } = await import('../src/main/discord/api');
const { postingClient } = await import('../src/main/plugins/posting');
const CHANNEL = '100000000000000001', MESSAGE = '200000000000000001', OWNER = '300000000000000001';
const SAVED_AT = '2026-10-01T12:00:00.000Z';
const FUTURE = '2090-10-01T12:00:00.000Z';
const target = { channelId: CHANNEL, messageId: MESSAGE };
function wire(dueAt: string | null = null, id = MESSAGE) {
  return { message: null, save_data: { channel_id: CHANNEL, message_id: id, guild_id: '0', saved_at: SAVED_AT, due_at: dueAt, author_summary: 'Alice', channel_summary: '#general', message_summary: 'Saved text' } };
}
function setup(clientOverride?: DiscordClient | ((capture: HeaderCapture) => DiscordClient)) {
  const tap = new EventEmitter();
  let onHeaders!: (details: unknown, callback: (result: unknown) => void) => void;
  const capture = new HeaderCapture({ webRequest: { onBeforeRequest: () => undefined, onCompleted: () => undefined,
    onBeforeSendHeaders: (_filter: unknown, listener: typeof onHeaders) => { onHeaders = listener; } } } as never);
  const recapture = (authorization = 'token') => onHeaders({ method: 'GET', url: 'https://discord.com/api/v9/users/@me', webContentsId: 1, requestHeaders: { Authorization: authorization } }, () => undefined);
  const available = vi.fn(); capture.onAvailable = available;
  const identify = (token = 'token', socketId = 'socket') => tap.emit('sent', { op: 2, d: { token }, socketId });
  const dispatchReady = (owner = OWNER, socketId = 'socket') => tap.emit('dispatch', { t: 'READY', d: { user: { id: owner } }, socketId });
  const sent: { method: string; path: string; body?: unknown; query?: unknown; opts?: RequestOptions }[] = [];
  let before: (() => void) | undefined;
  let answer: unknown = { reminders: [], bookmark_ids: [MESSAGE] };
  const request = async (method: string, path: string, body: unknown, opts?: RequestOptions, query?: unknown) => {
    before?.(); await opts?.guard?.(); opts?.verify?.(); sent.push({ method, path, body, opts, query });
    if (method === 'GET' && answer instanceof Error) throw answer;
    return method === 'PUT' ? wire((body as { due_at?: string }).due_at ?? null) : method === 'GET' ? answer : undefined;
  };
  const client = { get: (p: string, q?: unknown, o?: RequestOptions) => request('GET', p, undefined, o, q),
    putJson: (p: string, b: unknown, o?: WriteOptions) => request('PUT', p, b, o), delete: (p: string, o?: WriteOptions) => request('DELETE', p, undefined, o) } as DiscordClient;
  const visible = vi.fn(async () => true), filter = vi.fn(async (items: SavedMessage[], bookmarkIds: string[]) => ({ items, bookmarkIds }));
  const emit = vi.fn();
  const writable = vi.fn(async () => [CHANNEL]);
  const service = new SavedMessages({ client: typeof clientOverride === 'function' ? clientOverride(capture) : clientOverride ?? client, capture, tap: tap as never, visible, filter, writable, emit });
  const ready = (owner = OWNER) => { const token = owner === OWNER ? 'token' : 'other-token'; identify(token); recapture(token); dispatchReady(owner); };
  ready();
  return { service, sent, capture, tap, ready, identify, dispatchReady, recapture, available, visible, filter, writable, emit,
    set before(fn: () => void) { before = fn; }, set answer(value: unknown) { answer = value; },
    reauthenticate: recapture };
}

describe('native saved-message contract', () => {
  it('matches native empty-index handling for 404/10133 and allows a guarded first save', async () => {
    const f = setup(); f.answer = new DiscordHttpError('Unknown Saved Messages', 404, 10133);
    const index = await f.service.index();
    expect(index.indexReadFailed).toBe(true);
    expect(index.reminders).toEqual([]); expect(index.bookmarkIds).toEqual([]); expect(index.writableChannelIds).toEqual([CHANNEL]);
    expect((await f.service.bookmarks({ session: index.session, pageEpoch: index.pageEpoch })).bookmarks).toEqual([]);
    await f.service.save({ ...target, ...index, source: 'context_menu' });
    expect((await f.service.index()).bookmarkIds).toEqual([MESSAGE]);
    expect((await f.service.index()).indexReadFailed).toBe(true);
    expect((await f.service.bookmarks({ session: index.session })).bookmarks.map((m) => m.messageId)).toEqual([MESSAGE]);
    expect((await f.service.bookmarks({ session: index.session, refresh: true })).bookmarks.map((m) => m.messageId)).toEqual([MESSAGE]);
    expect(f.sent.map((r) => [r.method, r.path])).toEqual([
      ['GET', 'users/@me/saved-messages'], ['PUT', `users/@me/saved-messages/${CHANNEL}/${MESSAGE}`],
    ]);
    f.answer = { reminders: [], bookmark_ids: [MESSAGE] };
    expect((await f.service.index(true)).indexReadFailed).toBeUndefined();
  });
  it('keeps privacy, permission, saved-identity and account guards after a native unknown-index response', async () => {
    const f = setup(); f.answer = new DiscordHttpError('Unknown Saved Messages', 404, 10133);
    const index = await f.service.index();
    await expect(f.service.remove({ ...target, ...index })).rejects.toThrow(/no longer saved/);
    await expect(f.service.save({ ...target, ...index, source: 'for_later_list' })).rejects.toThrow(/no longer saved/);
    f.visible.mockResolvedValue(false);
    await expect(f.service.save({ ...target, ...index, source: 'context_menu' })).rejects.toThrow(/privacy/);
    f.visible.mockResolvedValue(true); f.writable.mockResolvedValue([]);
    await expect(f.service.save({ ...target, ...index, source: 'context_menu' })).rejects.toThrow(/read-history/);
    f.writable.mockResolvedValue([CHANNEL]); f.capture.invalidate();
    await expect(f.service.save({ ...target, ...index, source: 'context_menu' })).rejects.toThrow(/account changed/i);
    expect(f.sent).toHaveLength(1);
  });
  it.each([true, false])('keeps saves newest-first without another page request after an empty index (10133=%s)', async (unknownIndex) => {
    const secondId = '200000000000000002';
    const older = { ...wire(), save_data: { ...wire().save_data, saved_at: '2026-10-01T12:00:00.000001Z' } };
    const newer = { ...wire(null, secondId), save_data: { ...wire(null, secondId).save_data, saved_at: '2026-10-01T12:00:00.000002Z' } };
    const get = vi.fn(async () => {
      if (unknownIndex) throw new DiscordHttpError('Unknown Saved Messages', 404, 10133);
      return { reminders: [], bookmark_ids: [] };
    });
    const putJson = vi.fn(async (path: string, _body: unknown, opts?: WriteOptions) => {
      await opts?.guard?.(); opts?.verify?.();
      return path.endsWith(`/${secondId}`) ? newer : older;
    });
    const f = setup({ get, putJson } as unknown as DiscordClient), first = await f.service.index();
    expect(first.indexReadFailed).toBe(unknownIndex ? true : undefined);
    await f.service.save({ ...target, ...first, source: 'context_menu' });
    const second = await f.service.index();
    await f.service.save({ ...target, ...second, messageId: secondId, source: 'context_menu' });
    const current = await f.service.index();
    expect(current.indexReadFailed).toBe(unknownIndex ? true : undefined);
    for (const refresh of [false, true]) {
      const page = await f.service.bookmarks({ session: current.session, refresh });
      expect(page.bookmarks.map((m) => m.messageId)).toEqual([secondId, MESSAGE]);
      expect(page.hasMore).toBe(false); expect(page.nextBefore).toBeNull();
    }
    expect(get).toHaveBeenCalledTimes(1); expect(putJson).toHaveBeenCalledTimes(2);
  });
  it('does not adopt an unknown-index response after its account changes, or normalize other server errors', async () => {
    const get = vi.fn().mockResolvedValue({ reminders: [], bookmark_ids: [] });
    const f = setup({ get } as unknown as DiscordClient);
    get.mockImplementationOnce(async (_path: string, _query: unknown, opts?: RequestOptions) => {
      opts?.verify?.(); f.ready('300000000000000002'); throw new DiscordHttpError('Unknown Saved Messages', 404, 10133);
    });
    await expect(f.service.index()).rejects.toThrow(/account/i);
    expect((await f.service.index()).bookmarkIds).toEqual([]); expect(get).toHaveBeenCalledTimes(2);
    for (const [status, code] of [[404, 10003], [403, 10133], [500, 10133]] as const) {
      const other = setup(); other.answer = new DiscordHttpError('Other failure', status, code);
      await expect(other.service.index()).rejects.toThrow();
      expect(other.sent).toHaveLength(1);
    }
  });
  it('replays a native save during an unknown-index read without a bookmark page request', async () => {
    let rejectRead!: (error: Error) => void;
    const get = vi.fn(() => new Promise((_, reject) => { rejectRead = reject; }));
    const f = setup({ get } as unknown as DiscordClient), read = f.service.index();
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    f.tap.emit('dispatch', { socketId: 'socket', t: 'SAVED_MESSAGE_CREATE', d: wire() });
    rejectRead(new DiscordHttpError('Unknown Saved Messages', 404, 10133));
    const index = await read;
    expect(index.bookmarkIds).toEqual([MESSAGE]);
    expect((await f.service.bookmarks({ session: index.session, pageEpoch: index.pageEpoch, refresh: true })).bookmarks.map((m) => m.messageId)).toEqual([MESSAGE]);
    expect(get).toHaveBeenCalledTimes(1);
  });
  it('clears previous local saves when an explicit index refresh again returns the native unknown-index response', async () => {
    const f = setup(); f.answer = new DiscordHttpError('Unknown Saved Messages', 404, 10133);
    const index = await f.service.index();
    await f.service.save({ ...target, ...index, source: 'context_menu' });
    expect((await f.service.index()).bookmarkIds).toEqual([MESSAGE]);
    const refreshed = await f.service.index(true);
    expect(refreshed.bookmarkIds).toEqual([]);
    await expect(f.service.remove({ ...target, ...refreshed })).rejects.toThrow(/no longer saved/);
    expect((await f.service.bookmarks({ session: refreshed.session, pageEpoch: refreshed.pageEpoch })).bookmarks).toEqual([]);
    expect(f.sent.map((r) => r.method)).toEqual(['GET', 'PUT', 'GET']);
  });
  it('repairs access changes during the initial permission read and avoids a second forced page read within the retry cap', async () => {
    const f = setup(); let resolve!: (ids: string[]) => void;
    f.writable.mockImplementationOnce(() => new Promise((r) => { resolve = r; })); f.writable.mockResolvedValue([]);
    const pending = f.service.index(); await vi.waitFor(() => expect(f.writable).toHaveBeenCalledTimes(1)); f.emit.mockClear();
    f.tap.emit('dispatch', { socketId: 'socket', t: 'CHANNEL_UPDATE', d: { id: CHANNEL } }); resolve([CHANNEL]); await pending;
    await vi.waitFor(() => expect(f.emit).toHaveBeenCalledTimes(1)); expect((await f.service.index()).writableChannelIds).toEqual([]);
    f.answer = { reminders: [], bookmark_ids: [MESSAGE] }; const { session, pageEpoch } = await f.service.index(true);
    f.answer = { results: [wire()], has_more: true }; await f.service.bookmarks({ session, pageEpoch });
    const count = f.sent.length; await f.service.bookmarks({ session, pageEpoch, refresh: true }); expect(f.sent).toHaveLength(count);
  });
  it('does not cancel actions for foreign members or unchanged channel access, and coalesces real access changes', async () => {
    const f = setup(); f.answer = { reminders: [], bookmark_ids: [] }; const stamp = await f.service.index(); f.emit.mockClear();
    f.tap.emit('dispatch', { socketId: 'socket', t: 'GUILD_MEMBER_UPDATE', d: { user: { id: '300000000000000002' } } });
    f.tap.emit('dispatch', { socketId: 'socket', t: 'THREAD_CREATE', d: { id: '100000000000000002' } });
    await vi.waitFor(() => expect(f.writable).toHaveBeenCalledTimes(2)); expect(f.emit).not.toHaveBeenCalled();
    await f.service.save({ ...target, ...stamp, source: 'context_menu' }); expect(f.sent.filter((r) => r.method === 'PUT')).toHaveLength(1);
    const next = await f.service.index(); f.emit.mockClear(); f.writable.mockResolvedValue([]);
    for (let i = 0; i < 3; i++) f.tap.emit('dispatch', { socketId: 'socket', t: 'CHANNEL_UPDATE', d: { id: CHANNEL } });
    await vi.waitFor(() => expect(f.emit).toHaveBeenCalledTimes(1));
    await expect(f.service.save({ ...target, ...next, source: 'context_menu' })).rejects.toThrow(/changed/);
    expect(f.sent.filter((r) => r.method === 'PUT')).toHaveLength(1);
  });
  it('keeps a failed read across re-identification, caps explicit retries, and releases it for another account', async () => {
    vi.useFakeTimers();
    const f = setup(); f.answer = new DiscordHttpError('Unknown Saved Messages', 404);
    await expect(f.service.index()).rejects.toThrow(/Refresh/); f.ready();
    await expect(f.service.index()).rejects.toThrow(/Refresh/); expect(f.sent).toHaveLength(1);
    await expect(f.service.index(true)).rejects.toThrow(/Refresh/); expect(f.sent).toHaveLength(2);
    f.ready(); await expect(f.service.index(true)).rejects.toThrow(/Refresh/); expect(f.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(SAVED_REFRESH_INTERVAL_MS);
    await expect(f.service.index(true)).rejects.toThrow(/Refresh/); expect(f.sent).toHaveLength(3);
    f.ready('300000000000000002'); f.answer = { reminders: [], bookmark_ids: [] };
    expect((await f.service.index()).bookmarkIds).toEqual([]); expect(f.sent).toHaveLength(4);
  });
  it('refreshes two views together without keeping obsolete cursors or issuing duplicate reads', async () => {
    const second = { ...wire(null, '200000000000000002'), save_data: { ...wire(null, '200000000000000002').save_data, saved_at: '2026-09-30T12:00:00.000Z' } };
    const get = vi.fn(async (path: string, query?: { before?: string }) => path.endsWith('/bookmarks') ? { results: [query?.before ? second : wire()], has_more: !query?.before } : { reminders: [], bookmark_ids: [MESSAGE, second.save_data.message_id] });
    const f = setup({ get } as unknown as DiscordClient);
    const storePath = '../src/renderer/src/state/savedMessageStore';
    const { SavedMessageStore } = await import(storePath) as typeof import('../src/renderer/src/state/savedMessageStore');
    const api = { savedMessages: (force?: boolean) => f.service.index(force), savedBookmarks: (v: unknown) => f.service.bookmarks(v) };
    const a = new SavedMessageStore(api, () => undefined), b = new SavedMessageStore(api, () => undefined);
    f.emit.mockImplementation((e) => queueMicrotask(() => {
      for (const store of [a, b]) {
        const loaded = store.state.session !== null || store.state.loading;
        store.invalidate(e.session, e.revision, e.reset, e.pageEpoch);
        if (loaded && !e.reset) void store.refresh();
      }
    }));
    await Promise.all([a.refresh(), b.refresh()]); await b.loadMore(); expect(b.state.bookmarks).toHaveLength(2); expect(get).toHaveBeenCalledTimes(3);
    await a.refresh(true); await b.refresh();
    expect(a.state.error).toBe(''); expect(b.state.error).toBe(''); expect(b.state.bookmarks).toHaveLength(1);
    expect(a.state.pageEpoch).toBe(b.state.pageEpoch); await b.loadMore(); expect(b.state.bookmarks).toHaveLength(2); expect(get).toHaveBeenCalledTimes(6);
  });
  it('does not use an unlinked bare bookmark or a known wrong channel to bypass new-save permission', async () => {
    const f = setup(); f.filter.mockImplementation(async (items) => ({ items, bookmarkIds: [] })); f.writable.mockResolvedValue([]);
    const stamp = await f.service.index(); await expect(f.service.save({ ...target, ...stamp, source: 'context_menu' })).rejects.toThrow(/read-history/);
    f.answer = { results: [wire()], has_more: false }; await f.service.bookmarks({ session: stamp.session });
    await expect(f.service.save({ ...target, ...stamp, channelId: '100000000000000002', source: 'context_menu' })).rejects.toThrow(/another channel/);
    expect(f.sent.every((r) => r.method === 'GET')).toBe(true);
  });
  it('does not retrigger the existing full-sync callback on credential replacement', () => {
    const f = setup(), invalidated = vi.fn(); f.capture.onInvalidated(invalidated);
    expect(f.available).toHaveBeenCalledTimes(1); f.recapture('other-token');
    expect(f.available).toHaveBeenCalledTimes(1); expect(invalidated).toHaveBeenCalledExactlyOnceWith('replaced');
    f.capture.invalidate(); f.recapture('other-token'); expect(f.available).toHaveBeenCalledTimes(2);
  });
  it('retains proven same-token RESUME and rejects unproven or different-token resume', async () => {
    const f = setup(), original = await f.service.index();
    f.tap.emit('sent', { socketId: 'resumed', op: 6, d: { token: 'token' } });
    f.tap.emit('dispatch', { socketId: 'resumed', t: 'RESUMED', d: {} });
    expect((await f.service.index()).session).toBe(original.session);
    f.tap.emit('dispatch', { socketId: 'socket', t: 'SAVED_MESSAGE_CREATE', d: wire(FUTURE) });
    expect((await f.service.index()).reminders).toEqual([]);
    f.tap.emit('sent', { socketId: 'bad', op: 6, d: { token: 'other-token' } }); f.recapture('other-token');
    f.tap.emit('dispatch', { socketId: 'bad', t: 'RESUMED', d: {} });
    f.dispatchReady('300000000000000002', 'bad'); await expect(f.service.index()).rejects.toThrow(/sign in/);
    f.capture.invalidate(); f.recapture(); f.tap.emit('sent', { socketId: 'unproven', op: 6, d: { token: 'token' } });
    f.tap.emit('dispatch', { socketId: 'unproven', t: 'RESUMED', d: {} }); await expect(f.service.index()).rejects.toThrow(/sign in/);
  });
  it('requires an index and native advancing cursor, and skips pages when the raw index is empty', async () => {
    const f = setup(), boundSession = f.emit.mock.calls.at(-1)![0].session;
    await expect(f.service.bookmarks({ session: boundSession })).rejects.toThrow(/index/); expect(f.sent).toHaveLength(0);
    f.answer = { reminders: [], bookmark_ids: [] }; const { session } = await f.service.index();
    expect((await f.service.bookmarks({ session })).bookmarks).toEqual([]); expect(f.sent).toHaveLength(1);
    await expect(f.service.bookmarks({ session, before: SAVED_AT })).rejects.toThrow(/cursor/); expect(f.sent).toHaveLength(1);
    f.answer = { reminders: [], bookmark_ids: [MESSAGE] }; await f.service.index(true);
    f.answer = { results: [wire()], has_more: false }; await f.service.bookmarks({ session });
    await expect(f.service.bookmarks({ session, before: SAVED_AT })).rejects.toThrow(/cursor/); expect(f.sent).toHaveLength(3);
  });
  it.each([true, false])('Refresh clears later page failures and caches (failure=%s)', async (failure) => {
    const f = setup(), { session } = await f.service.index(); f.answer = { results: [wire()], has_more: true }; await f.service.bookmarks({ session });
    f.answer = failure ? new DiscordHttpError('Offline', 503) : { results: [], has_more: false };
    if (failure) await expect(f.service.bookmarks({ session, before: SAVED_AT })).rejects.toThrow('Offline'); else await f.service.bookmarks({ session, before: SAVED_AT });
    expect(f.sent).toHaveLength(3);
    f.answer = { reminders: [], bookmark_ids: [MESSAGE] }; await f.service.index(true);
    f.answer = { results: [wire()], has_more: true }; await f.service.bookmarks({ session, refresh: true });
    f.answer = { results: [], has_more: false }; await f.service.bookmarks({ session, before: SAVED_AT }); expect(f.sent).toHaveLength(6);
  });
  it('replays native events received during an index read instead of refetching or latching a conflict', async () => {
    let resolve!: (v: unknown) => void;
    const get = vi.fn(() => new Promise((r) => { resolve = r; })), f = setup({ get } as unknown as DiscordClient);
    const pending = f.service.index(); f.tap.emit('dispatch', { socketId: 'socket', t: 'SAVED_MESSAGE_CREATE', d: wire(FUTURE) });
    resolve({ reminders: [], bookmark_ids: [] }); expect((await pending).reminders).toHaveLength(1);
    expect((await f.service.index()).reminders).toHaveLength(1); expect(get).toHaveBeenCalledTimes(1);
  });
  it('fails closed on malformed saved events without serving old cached content or requesting again', async () => {
    const f = setup(); await f.service.index(); f.tap.emit('dispatch', { socketId: 'socket', t: 'SAVED_MESSAGE_CREATE', d: { save_data: {} } });
    await expect(f.service.index()).rejects.toThrow(/unreadable/); expect(f.sent).toHaveLength(1);
    expect((await f.service.index(true)).bookmarkIds).toEqual([MESSAGE]); expect(f.sent).toHaveLength(2);
  });
  it('requires native read-history access for a new save while existing records remain editable', async () => {
    const f = setup(); f.answer = { reminders: [], bookmark_ids: [] }; const stamp = await f.service.index();
    f.writable.mockResolvedValue([]); await expect(f.service.save({ ...target, ...stamp, source: 'context_menu' })).rejects.toThrow(/read-history/); expect(f.sent).toHaveLength(1);
    f.answer = { reminders: [], bookmark_ids: [MESSAGE] }; const current = await f.service.index(true);
    await f.service.save({ ...target, ...current, source: 'context_menu', dueAt: FUTURE });
    const next = await f.service.index(); await f.service.remove({ ...target, ...next });
    expect(f.sent.filter((r) => r.method !== 'GET')).toHaveLength(2);
  });
  it('decodes modern and historical lists, retaining unavailable summaries', () => {
    const saved = decodeSavedMessage(wire(FUTURE));
    expect(saved).toMatchObject({ ...target, dueAt: FUTURE, guildId: null, summary: 'Saved text', available: false });
    expect(decodeSavedIndex({ reminders: [wire(FUTURE)], bookmark_ids: [MESSAGE, MESSAGE] })).toMatchObject({ reminders: [saved], bookmarkIds: [MESSAGE] });
    expect(decodeSavedIndex({ results: [wire(), wire(FUTURE, '200000000000000002')] }).legacyBookmarks).toHaveLength(1);
  });
  it('uses the original author when native summaries are absent, forwarding only identity and avatar hash', () => {
    const data = { ...wire().save_data, author_summary: '', message_summary: '' };
    const author = { id: OWNER, username: 'alice', global_name: 'Alice', avatar: `a_${'a'.repeat(32)}`, token: 'never-forward', avatar_url: 'https://untrusted.invalid/avatar' };
    const decoded = decodeSavedMessage({ save_data: data, message: { id: MESSAGE, channel_id: CHANNEL, content: '**Saved text**', author } });
    expect(decoded).toMatchObject({ authorName: 'Alice', summary: '**Saved text**', author: { id: OWNER, avatar: author.avatar } });
    expect(decoded.author).toEqual({ id: OWNER, avatar: author.avatar });
    expect(JSON.stringify(decoded)).not.toContain('never-forward');
    expect(JSON.stringify(decoded)).not.toContain('untrusted.invalid');
  });
  it('does not turn arbitrary author ids or avatar URLs into media paths', () => {
    const data = { ...wire().save_data, author_summary: '' };
    const decode = (author: unknown) => decodeSavedMessage({ save_data: data, message: { id: MESSAGE, channel_id: CHANNEL, author } });
    expect(decode({ id: OWNER, username: 'Alice', avatar: '../image?token=secret' }).author).toEqual({ id: OWNER, avatar: null });
    expect(decode({ id: '../users', username: 'Alice', avatar: 'a'.repeat(32) }).author).toBeUndefined();
    expect(decode(null).author).toBeUndefined();
  });
  it('refuses malformed responses, wrong identities, mixed record types and nonadvancing cursors', () => {
    expect(() => decodeSavedIndex({})).toThrow();
    expect(() => decodeSavedIndex({ reminders: [wire()], bookmark_ids: [] })).toThrow();
    expect(() => decodeSavedMessage({ ...wire(), message: { id: 'different', channel_id: CHANNEL } })).toThrow();
    expect(() => decodeSavedPage({ results: [], has_more: true })).toThrow(/advance/);
    expect(() => decodeSavedPage({ results: [wire()], has_more: true }, SAVED_AT)).toThrow(/advance/);
    expect(() => decodeSavedPage({ results: [wire(FUTURE)], has_more: false })).toThrow();
  });
  it('sends exactly the native index/page queries and uses save time as the cursor', async () => {
    const f = setup(), index = await f.service.index();
    expect(f.sent[0]).toMatchObject({ method: 'GET', path: 'users/@me/saved-messages', query: { bookmark_ids: 'true' } });
    f.answer = { results: [wire()], has_more: true };
    const page = await f.service.bookmarks({ session: index.session });
    expect(f.sent[1]?.query).toEqual({ limit: SAVED_BOOKMARK_PAGE_SIZE, before: undefined });
    expect(page.nextBefore).toBe(SAVED_AT);
    f.answer = { results: [], has_more: false };
    await f.service.bookmarks({ session: index.session, before: page.nextBefore });
    expect(f.sent[2]?.query).toEqual({ limit: SAVED_BOOKMARK_PAGE_SIZE, before: SAVED_AT });
    expect(Object.entries(f.sent[2]!.query as object)).toEqual([['before', SAVED_AT], ['limit', SAVED_BOOKMARK_PAGE_SIZE]]);
  });
  it('omits due_at for bookmarks, uses ISO for reminders and deletes to complete, without ambiguous server retries', async () => {
    const f = setup(), { session } = await f.service.index();
    await f.service.save({ ...target, session, revision: (await f.service.index()).revision, source: 'context_menu' });
    await f.service.save({ ...target, session, revision: (await f.service.index()).revision, source: 'for_later_list', dueAt: FUTURE });
    await f.service.remove({ ...target, session, revision: (await f.service.index()).revision });
    expect(f.sent.slice(1).map((r) => [r.method, r.path, r.body, (r.opts as WriteOptions).once])).toEqual([
      ['PUT', `users/@me/saved-messages/${CHANNEL}/${MESSAGE}`, { source: 'context_menu' }, true],
      ['PUT', `users/@me/saved-messages/${CHANNEL}/${MESSAGE}`, { source: 'for_later_list', due_at: FUTURE }, true],
      ['DELETE', `users/@me/saved-messages/${CHANNEL}/${MESSAGE}`, undefined, true],
    ]);
    expect(JSON.stringify(f.sent[2]!.body)).toBe(`{"due_at":"${FUTURE}","source":"for_later_list"}`);
  });
  it('binds READY only to its observed IDENTIFY and matching REST capture, in either capture order', async () => {
    const f = setup(), initial = await f.service.index();
    f.identify('other-token', 'b'); f.dispatchReady('300000000000000002', 'b');
    await expect(f.service.index()).rejects.toThrow(/sign in/);
    // Late READY from the old socket cannot attach account A to B's credentials.
    f.dispatchReady(OWNER, 'socket'); f.recapture('other-token');
    const switched = await f.service.index(); expect(switched.session).not.toBe(initial.session);
    f.recapture('token'); await expect(f.service.index()).rejects.toThrow(/sign in/);
    f.recapture('other-token'); expect((await f.service.index()).session).not.toBe(switched.session);
    f.capture.invalidate(); f.recapture('other-token'); f.dispatchReady('300000000000000002', 'b');
    await expect(f.service.index()).rejects.toThrow(/sign in/);
    f.recapture('token'); f.identify(); f.dispatchReady();
    expect((await f.service.index()).session).not.toBe(initial.session);
  });
  it('shares reads across windows and handles edits, native saves, deletion and PUT echoes without extra GETs', async () => {
    const f = setup();
    const [a, b] = await Promise.all([f.service.index(), f.service.index()]); expect(a).toEqual(b); expect(f.sent).toHaveLength(1);
    f.answer = { results: [wire()], has_more: false };
    await Promise.all([f.service.bookmarks({ session: a.session }), f.service.bookmarks({ session: a.session })]); expect(f.sent).toHaveLength(2);
    for (let i = 0; i < 25; i++) f.tap.emit('dispatch', { socketId: 'socket', t: 'MESSAGE_UPDATE', d: { id: MESSAGE, content: 'edited' } });
    await f.service.index(); await f.service.bookmarks({ session: a.session }); expect(f.sent).toHaveLength(2);
    const stamp = await f.service.index();
    await f.service.save({ ...target, session: stamp.session, revision: stamp.revision, source: 'context_menu', dueAt: FUTURE });
    const current = await f.service.index(); expect(current.reminders).toHaveLength(1);
    f.tap.emit('dispatch', { socketId: 'socket', t: 'SAVED_MESSAGE_CREATE', d: wire(FUTURE) });
    expect((await f.service.index()).revision).toBe(current.revision);
    f.tap.emit('dispatch', { socketId: 'socket', t: 'SAVED_MESSAGE_DELETE', d: { channel_id: CHANNEL, message_id: MESSAGE } });
    expect((await f.service.index()).reminders).toEqual([]);
    await f.service.bookmarks({ session: a.session }); expect(f.sent.filter((r) => r.method === 'GET')).toHaveLength(2);
  });
  it('latches a refusal across ordinary reads until an explicit refresh', async () => {
    const get = vi.fn(async () => { throw new DiscordHttpError('Unknown Saved Messages', 404); });
    const f = setup({ get } as unknown as DiscordClient);
    await expect(f.service.index()).rejects.toThrow(/404.*cause is not confirmed/);
    await expect(f.service.index()).rejects.toThrow(/Refresh/);
    expect(get).toHaveBeenCalledTimes(1);
    await expect(f.service.index(true)).rejects.toThrow(/Refresh/); expect(get).toHaveBeenCalledTimes(2);
  });
  it('rejects a stale mutation revision and changed privacy after an awaited attempt guard', async () => {
    const f = setup(), { session, revision } = await f.service.index();
    f.tap.emit('dispatch', { socketId: 'socket', t: 'SAVED_MESSAGE_CREATE', d: wire(FUTURE) });
    await expect(f.service.remove({ ...target, session, revision })).rejects.toThrow(/changed/);
    f.visible.mockImplementationOnce(async () => true).mockImplementationOnce(async () => { f.service.privacyChanged(); return true; });
    await expect(f.service.remove({ ...target, session, revision: (await f.service.index()).revision })).rejects.toThrow(/changed/);
    expect(f.sent).toHaveLength(1);
  });
  it('compares microsecond cursors without truncation', () => {
    const newer = { ...wire(), save_data: { ...wire().save_data, saved_at: '2026-10-01T12:00:00.000002Z' } };
    const older = { ...wire(), save_data: { ...wire().save_data, saved_at: '2026-10-01T12:00:00.000001Z' } };
    expect(decodeSavedPage({ results: [older], has_more: true }, newer.save_data.saved_at).nextBefore).toBe(older.save_data.saved_at);
    expect(() => decodeSavedPage({ results: [newer], has_more: true }, older.save_data.saved_at)).toThrow(/advance/);
  });
  it('validates all untrusted mutation inputs before any request', async () => {
    const f = setup(), { session, revision } = await f.service.index();
    for (const change of [{ channelId: '../@me' }, { messageId: 'x?source=anything' }, { source: 'arbitrary' }, { dueAt: null }, { dueAt: '2000-01-01T00:00:00Z' }, { dueAt: '2090-02-30T00:00:00Z' }, { session: 'stale' }])
      await expect(f.service.save({ ...target, session, revision, source: 'context_menu', ...change })).rejects.toThrow();
    await expect(f.service.bookmarks({ session, before: '?limit=500' })).rejects.toThrow();
    expect(f.sent).toHaveLength(1);
  });
  it('rechecks privacy before attempts and refuses unknown privacy on failure', async () => {
    const f = setup(), { session, revision } = await f.service.index();
    f.visible.mockResolvedValue(false);
    await expect(f.service.save({ ...target, session, revision, source: 'context_menu' })).rejects.toThrow(/privacy/);
    f.visible.mockRejectedValue(new Error('Core unavailable'));
    await expect(f.service.remove({ ...target, session, revision })).rejects.toThrow('Core unavailable');
    expect(f.sent).toHaveLength(1);
  });
  it('blocks an account switch in queued reads/writes and requires READY after auth invalidation', async () => {
    const f = setup(), { session, revision } = await f.service.index();
    f.before = () => f.ready('300000000000000002');
    await expect(f.service.save({ ...target, session, revision, source: 'context_menu' })).rejects.toThrow(/account changed/);
    expect(f.sent).toHaveLength(1);
    f.capture.invalidate(); f.reauthenticate();
    await expect(f.service.index()).rejects.toThrow(/sign in/);
    f.before = () => undefined; f.ready();
    expect((await f.service.index()).session).not.toBe(session);
  });
  it('does not return a response or filtered content after its account changed', async () => {
    const f = setup();
    f.filter.mockImplementationOnce(async (items, bookmarkIds) => { f.ready('300000000000000002'); return { items, bookmarkIds }; });
    await expect(f.service.index()).rejects.toThrow(/account changed/);
  });
  it('turns the native limit code into a useful server refusal', async () => {
    const client = { get: async () => ({ reminders: [], bookmark_ids: [] }), putJson: async () => { throw new DiscordHttpError('Limit', 400, SAVED_LIMIT_CODE); } } as unknown as DiscordClient;
    const f = setup(client), { session, revision } = await f.service.index();
    await expect(f.service.save({ ...target, session, revision, source: 'context_menu' })).rejects.toThrow(/limit was reached/);
  });
});

afterEach(() => vi.useRealTimers());
describe('existing embedded-page transport protections', () => {
  it('recognizes the native unknown-index response through the actual protected transport and code decoder', async () => {
    const evaluate = vi.fn(async () => ({ status: 404, headers: {}, body: JSON.stringify({ message: 'Unknown Saved Messages', code: 10133 }) }));
    const f = setup((capture) => new DiscordApi(() => ({ webContents: { isDestroyed: () => false }, world: { evaluate } }) as never, capture, async () => ({ apiMs: 0, mediaMs: 0, jitter: 0 })).prompt);
    const index = await f.service.index(); expect(index.bookmarkIds).toEqual([]);
    await f.service.bookmarks({ session: index.session }); await f.service.index();
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
  it('does not retry saved reads on a server failure, while retaining the shared transport', async () => {
    let attempts = 0;
    const f = setup((capture) => new DiscordApi(() => ({ webContents: { isDestroyed: () => false }, world: { evaluate: async () => { attempts++; return { status: 503, headers: {}, body: '{"message":"Offline"}' }; } } }) as never, capture, async () => ({ apiMs: 0, mediaMs: 0, jitter: 0 })).prompt);
    await expect(f.service.index()).rejects.toThrow(/503/); await expect(f.service.index()).rejects.toThrow(/503/); expect(attempts).toBe(1);
    await expect(f.service.index(true)).rejects.toThrow(/503/); expect(attempts).toBe(2);
  });
  it.each(['account', 'privacy'] as const)('fences %s changes during an actual saved-message 429 retry', async (change) => {
    vi.useFakeTimers();
    let attempts = 0;
    const f = setup((capture) => {
      const evaluate = async (script: string) => {
        const q = JSON.parse(/const q = (.*);\n/.exec(script)![1]!);
        if (q.method === 'GET') return { status: 200, headers: {}, body: JSON.stringify({ reminders: [], bookmark_ids: [] }) };
        attempts++;
        if (change === 'account') f.ready('300000000000000002'); else f.service.privacyChanged();
        return { status: 429, headers: { 'retry-after': '0.01' }, body: JSON.stringify({ retry_after: 0.01 }) };
      };
      const api = new DiscordApi(() => ({ webContents: { isDestroyed: () => false }, world: { evaluate } }) as never, capture, async () => ({ apiMs: 0, mediaMs: 0, jitter: 0 }));
      return postingClient(api.prompt, { unlocked: async () => true });
    });
    const { session, revision } = await f.service.index();
    const pending = f.service.save({ ...target, session, revision, source: 'context_menu' });
    const assertion = expect(pending).rejects.toThrow(/changed/);
    await vi.advanceTimersByTimeAsync(3000); await assertion; expect(attempts).toBe(1);
  });
  it('keeps captured headers, browser credentials, shape checks and own-request suppression for native saves', async () => {
    const f = setup();
    const check = vi.fn(), own = vi.spyOn(f.capture, 'own');
    const requests: { url: string; q: { method: string; headers: Record<string, string>; credentials: string; body?: { text: string } } }[] = [];
    const evaluate = async (script: string) => {
      const q = JSON.parse(/const q = (.*);\n/.exec(script)![1]!);
      const url = JSON.parse(/const r = await fetch\((".*?"),/.exec(script)![1]!);
      requests.push({ url, q });
      expect(own).toHaveBeenLastCalledWith(q.method, url);
      return { status: 200, headers: {}, body: JSON.stringify(q.method === 'PUT' ? wire() : { reminders: [], bookmark_ids: [] }) };
    };
    const api = new DiscordApi(() => ({ webContents: { isDestroyed: () => false }, world: { evaluate } }) as never, f.capture as never, async () => ({ apiMs: 0, mediaMs: 0, jitter: 0 }), { check });
    const saved = setup(postingClient(api.prompt, { unlocked: async () => true }));
    const { session, revision } = await saved.service.index();
    await saved.service.save({ ...target, session, revision, source: 'context_menu' });
    expect(requests.map((r) => r.q.credentials)).toEqual(['include', 'include']);
    expect(requests[1]?.q.headers).toEqual({ Authorization: 'token', 'Content-Type': 'application/json' });
    expect(JSON.parse(requests[1]!.q.body!.text)).toEqual({ source: 'context_menu' });
    expect(check).toHaveBeenLastCalledWith('PUT /api/v9/users/@me/saved-messages/:id/:id', { fields: ['source'], kind: 'json' });
  });
  it('runs final synchronous verification after asynchronous guards, before any browser request', async () => {
    const evaluate = vi.fn(async () => ({ status: 204, headers: {}, body: '' }));
    let allowed = true;
    const f = setup(), api = new DiscordApi(() => ({ webContents: { isDestroyed: () => false }, world: { evaluate } }) as never, f.capture as never, async () => ({ apiMs: 0, mediaMs: 0, jitter: 0 }));
    await expect(api.prompt.putJson('users/@me/saved-messages/1/2', { source: 'context_menu' }, { guard: async () => { allowed = false; }, verify: () => { if (!allowed) throw new Error('Account changed'); } })).rejects.toThrow('Account changed');
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('posting relock during a 429 wait prevents retrying a save', async () => {
    vi.useFakeTimers();
    let unlocked = true;
    const evaluate = vi.fn(async () => { unlocked = false; return { status: 429, headers: { 'retry-after': '0.01' }, body: JSON.stringify({ retry_after: 0.01 }) }; });
    const f = setup(), api = new DiscordApi(() => ({ webContents: { isDestroyed: () => false }, world: { evaluate } }) as never, f.capture as never, async () => ({ apiMs: 0, mediaMs: 0, jitter: 0 }));
    const pending = postingClient(api.prompt, { unlocked: async () => unlocked }).putJson('users/@me/saved-messages/1/2', { source: 'context_menu' });
    const assertion = expect(pending).rejects.toThrow(/Posting is off/);
    await vi.advanceTimersByTimeAsync(3000); await assertion;
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
});
