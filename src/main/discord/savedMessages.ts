// Saved messages use the existing owner transport; no independent fetch, session or gateway.
import { randomUUID } from 'node:crypto';
import type { AppEvent } from '@shared/contract';
import { DiscordHttpError, snowflakeArg } from '@shared/discord';
import { SAVED_BOOKMARK_PAGE_SIZE, SAVED_LIMIT_CODE, SAVED_REFRESH_INTERVAL_MS, SAVED_SOURCES, reminderTime, savedKey, savedTarget, savedTimestamp, savedTimeOrder, type SavedBookmarkPage, type SavedIndex, type SavedMessage, type SavedRemove, type SavedVisible, type SavedWrite } from '@shared/savedMessages';
import type { DiscordClient } from './client';
import type { HeaderCapture } from './capture';
import type { GatewayTap } from './gatewayTap';

const PATH = 'users/@me/saved-messages';
const ACCESS_EVENTS = new Set(['READY_SUPPLEMENTAL', 'GUILD_CREATE', 'GUILD_UPDATE', 'GUILD_DELETE', 'GUILD_ROLE_CREATE', 'GUILD_ROLE_UPDATE', 'GUILD_ROLE_DELETE', 'GUILD_MEMBER_UPDATE', 'CHANNEL_CREATE', 'CHANNEL_UPDATE', 'CHANNEL_DELETE', 'THREAD_CREATE', 'THREAD_UPDATE', 'THREAD_DELETE', 'THREAD_LIST_SYNC', 'THREAD_MEMBER_UPDATE', 'THREAD_MEMBERS_UPDATE']);
const itemPath = (target: SavedRemove): string => `${PATH}/${target.channelId}/${target.messageId}`;
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Discord returned an unexpected saved-message response.');
  return value as ObjectValue;
}
const text = (value: unknown): string => typeof value === 'string' ? value : '';

/** Deliberately forwards plain summaries only, never a raw Discord message or media URL. */
export function decodeSavedMessage(value: unknown): SavedMessage {
  const record = object(value), data = object(record.save_data);
  const channelId = snowflakeArg(data.channel_id, 'saved channel'), messageId = snowflakeArg(data.message_id, 'saved message');
  const message = record.message == null ? null : object(record.message);
  if (message && (message.id !== messageId || message.channel_id !== channelId)) throw new Error('Discord returned a different saved message.');
  const guildId = data.guild_id == null || data.guild_id === '0' || data.guild_id === 0 ? null : snowflakeArg(data.guild_id, 'saved server');
  return { channelId, messageId, guildId, savedAt: savedTimestamp(data.saved_at), dueAt: data.due_at == null ? null : savedTimestamp(data.due_at),
    authorName: text(data.author_summary), channelName: text(data.channel_summary), summary: text(data.message_summary) || text(message?.content), available: message !== null };
}
function rows(value: unknown): SavedMessage[] {
  if (!Array.isArray(value)) throw new Error('Discord returned an unexpected saved-message list.');
  const decoded = value.map(decodeSavedMessage);
  if (new Set(decoded.map(savedKey)).size !== decoded.length) throw new Error('Discord returned duplicate saved messages.');
  return decoded;
}
export function decodeSavedIndex(value: unknown): Omit<SavedIndex, 'session' | 'revision' | 'writableChannelIds' | 'pageEpoch'> {
  const v = object(value);
  if (Array.isArray(v.results)) {
    const all = rows(v.results), bookmarks = all.filter((m) => m.dueAt === null);
    return { reminders: all.filter((m) => m.dueAt !== null), bookmarkIds: bookmarks.map((m) => m.messageId), legacyBookmarks: bookmarks };
  }
  if (!Array.isArray(v.bookmark_ids)) throw new Error('Discord returned an unexpected bookmark index.');
  const reminders = rows(v.reminders);
  if (reminders.some((m) => !m.dueAt)) throw new Error('Discord returned a bookmark in its reminder list.');
  return { reminders, bookmarkIds: [...new Set(v.bookmark_ids.map((id) => snowflakeArg(id, 'bookmarked message')))] };
}
export function decodeSavedPage(value: unknown, before?: string): Omit<SavedBookmarkPage, 'session' | 'revision' | 'pageEpoch'> {
  const v = object(value), bookmarks = rows(v.results);
  if (typeof v.has_more !== 'boolean' || bookmarks.some((m) => m.dueAt !== null)) throw new Error('Discord returned an unexpected bookmark page.');
  const cursor = bookmarks.at(-1)?.savedAt ?? null;
  if (bookmarks.some((m, i) => (before !== undefined && savedTimeOrder(m.savedAt) >= savedTimeOrder(before)) || (i > 0 && savedTimeOrder(m.savedAt) > savedTimeOrder(bookmarks[i - 1]!.savedAt))) || (v.has_more && (!cursor || cursor === before)))
    throw new Error('Discord returned a bookmark page that did not advance. Refresh saved messages.');
  return { bookmarks, hasMore: v.has_more, nextBefore: cursor };
}

export interface SavedMessagesDeps {
  client: DiscordClient;
  capture: Pick<HeaderCapture, 'current' | 'sessionGeneration' | 'onInvalidated' | 'onCaptured' | 'gatewayAuthorized' | 'expectGatewayAuthorization' | 'matchesGatewayAuthorization'>;
  tap: Pick<GatewayTap, 'on'>;
  filter(items: SavedMessage[], bookmarkIds: string[]): Promise<SavedVisible>;
  visible(target: { channelId: string; messageId: string }): Promise<boolean>;
  writable(accountId: string): Promise<string[]>;
  emit(event: AppEvent): void;
}
type IndexData = Omit<SavedIndex, 'session' | 'revision' | 'writableChannelIds' | 'pageEpoch'>;
type PageData = Omit<SavedBookmarkPage, 'session' | 'revision' | 'pageEpoch'>;
class SavedConflict extends Error {}
type CacheChange = { kind: 'save'; row: SavedMessage } | { kind: 'remove'; id: string } | { kind: 'deleted'; ids: string[] };
/** Passive IDENTIFY/READY and matching REST capture bind identity. The main-owned cache is shared by all views. */
export class SavedMessages {
  private session: string | null = null;
  private generation = -1;
  private revision = 0;
  private privacyRevision = 0;
  private socket: string | null = null;
  private ready = false;
  private identifying = false;
  private accountId: string | null = null;
  private cachedIndex: IndexData | null = null;
  private readonly pages = new Map<string, PageData>();
  private readonly known = new Map<string, SavedMessage>();
  private readonly readChanges = new Set<CacheChange[]>();
  private pageGeneration = 0;
  private cacheGeneration = 0;
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly failures = new Map<string, Error>();
  private failureOwner: string | null = null;
  private ownerFailure: Error | null = null;
  private readonly refreshAt = new Map<string, number>();
  private writableIds: string[] | null = null;
  private accessPending = false;
  private accessDirty = false;
  constructor(private readonly d: SavedMessagesDeps) {
    d.capture.onInvalidated((reason) => {
      if (reason !== 'replaced') { this.ready = false; this.identifying = false; this.socket = null; this.accountId = null; }
      this.reset();
    });
    d.capture.onCaptured(() => this.bind());
    d.tap.on('sent', ({ op, d: payload, socketId }) => {
      if ((op !== 2 && op !== 6) || !socketId || !payload || typeof payload !== 'object') return;
      const token = (payload as ObjectValue).token;
      if (op === 6 && this.ready && d.capture.matchesGatewayAuthorization(token)) { this.socket = socketId; this.identifying = false; return; }
      this.ready = false;
      this.identifying = op === 2;
      this.accountId = null;
      this.socket = socketId;
      d.capture.expectGatewayAuthorization(token);
      this.reset();
    });
    d.tap.on('dispatch', ({ t, d: payload, socketId }) => {
      if (!this.socket || socketId !== this.socket) return;
      if (t === 'READY') {
        this.ready = false;
        this.reset();
        if (!this.identifying) return;
        try { this.accountId = snowflakeArg(object(object(payload).user).id, 'owner'); this.ready = true; this.bind(); } catch { /* Malformed READY authorizes nothing. */ }
      } else if (!this.session || !d.capture.gatewayAuthorized) return;
      else if (t === 'SAVED_MESSAGE_CREATE') {
        try { this.upsert(decodeSavedMessage(payload)); } catch { this.malformedEvent(); }
      } else if (t === 'SAVED_MESSAGE_DELETE') {
        try { const row = object(payload); this.removeCached(snowflakeArg(row.message_id, 'saved message')); } catch { this.malformedEvent(); }
      }
      else if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
      // Discord retains save_data summaries on message edits/deletes. Mark availability locally, never refetch.
      else if (t === 'MESSAGE_DELETE') this.deleted([text(object(payload).id)]);
      else if (t === 'MESSAGE_DELETE_BULK' && Array.isArray(object(payload).ids)) this.deleted((object(payload).ids as unknown[]).map(text));
      else if (ACCESS_EVENTS.has(t)) {
        const data = object(payload);
        if (t === 'GUILD_MEMBER_UPDATE' && (data.user as ObjectValue | undefined)?.id !== this.accountId) return;
        if (t === 'THREAD_MEMBER_UPDATE' && data.user_id !== this.accountId) return;
        if (t === 'THREAD_MEMBERS_UPDATE' && !(Array.isArray(data.removed_member_ids) && data.removed_member_ids.includes(this.accountId)) && !(Array.isArray(data.added_members) && data.added_members.some((m) => m?.user_id === this.accountId || m?.member?.user?.id === this.accountId))) return;
        this.accessChanged();
      }
    });
  }
  private reset(): void { this.session = null; this.cachedIndex = null; this.cacheGeneration++; this.pages.clear(); this.pageGeneration++; this.known.clear(); this.readChanges.clear(); this.pending.clear(); this.failures.clear(); this.writableIds = null; this.accessDirty = false; this.changed(true); }
  private malformedEvent(): void {
    this.cachedIndex = null; this.cacheGeneration++; this.pending.delete('index'); this.clearPages(); this.known.clear(); this.ownerFailure = new Error('Discord sent an unreadable saved-message update. Use Refresh to retry, at most once per minute.'); this.failures.set('index', this.ownerFailure); this.changed(true);
  }
  private clearPages(notify = false): void {
    this.pageGeneration++; this.pages.clear();
    for (const key of this.failures.keys()) if (key.startsWith('page:')) this.failures.delete(key);
    for (const key of this.pending.keys()) if (key.startsWith('page:')) this.pending.delete(key);
    if (notify) this.notify(false);
  }
  private bind(): void {
    if (!this.ready || !this.d.capture.gatewayAuthorized || this.session) return;
    if (this.failureOwner !== this.accountId) { this.failureOwner = this.accountId; this.ownerFailure = null; this.refreshAt.clear(); }
    if (this.ownerFailure) this.failures.set('index', this.ownerFailure);
    this.session = randomUUID(); this.generation = this.d.capture.sessionGeneration; this.changed(true);
  }
  privacyChanged(): void { this.privacyRevision++; this.changed(true); }
  private notify(reset: boolean): void { this.d.emit({ type: 'saved-messages-changed', session: this.session, revision: this.revision, pageEpoch: this.pageGeneration, reset }); }
  private changed(reset: boolean): void { this.revision++; this.notify(reset); }
  private accessChanged(): void {
    this.accessDirty = true;
    if (this.writableIds === null) return; // Recheck after the first access read settles.
    if (this.accessPending) return;
    this.accessPending = true;
    const session = this.session, account = this.accountId;
    void Promise.resolve().then(async () => {
      while (this.accessDirty && this.session === session && account !== null) {
        this.accessDirty = false;
        let ids: string[];
        try { ids = await this.d.writable(account); } catch { ids = []; }
        if (this.session !== session) return;
        ids.sort();
        if (JSON.stringify(ids) !== JSON.stringify(this.writableIds)) { this.writableIds = ids; this.changed(false); }
      }
    }).finally(() => { this.accessPending = false; if (this.accessDirty) this.accessChanged(); });
  }
  private forceAllowed(key: string): boolean {
    const now = Date.now(), previous = this.refreshAt.get(key);
    if (previous !== undefined && now - previous < SAVED_REFRESH_INTERVAL_MS) return false;
    this.refreshAt.set(key, now); return true;
  }
  private stamp(expected?: unknown): { session: string; revision: number } {
    if (expected !== undefined && expected !== this.session) throw new SavedConflict('The Discord account changed. Refresh saved messages.');
    if (!this.session || !this.d.capture.gatewayAuthorized || !this.d.capture.current || this.generation !== this.d.capture.sessionGeneration) throw new Error('Open the live Discord client and sign in before using saved messages.');
    return { session: this.session, revision: this.revision };
  }
  private sameRevision(revision: number): void { if (revision !== this.revision) throw new SavedConflict('Saved messages changed. Refresh to try again.'); }
  private record(change: CacheChange): void { for (const changes of this.readChanges) changes.push(change); }
  private upsert(row: SavedMessage): void {
    const existing = this.known.get(row.messageId);
    if (existing && JSON.stringify(existing) === JSON.stringify(row)) return; // PUT followed by its native echo.
    this.record({ kind: 'save', row });
    this.drop(row.messageId);
    this.known.set(row.messageId, row);
    if (this.cachedIndex) {
      if (row.dueAt) this.cachedIndex.reminders.push(row);
      else { this.cachedIndex.bookmarkIds.push(row.messageId); this.cachedIndex.legacyBookmarks?.unshift(row); }
    }
    if (!row.dueAt) { const first = this.pages.get(''); if (first) { first.bookmarks.unshift(row); first.bookmarks.sort((a, b) => savedTimeOrder(a.savedAt) > savedTimeOrder(b.savedAt) ? -1 : 1); } }
    this.changed(false);
  }
  private drop(id: string): void {
    this.known.delete(id);
    if (this.cachedIndex) { this.cachedIndex.reminders = this.cachedIndex.reminders.filter((m) => m.messageId !== id); this.cachedIndex.bookmarkIds = this.cachedIndex.bookmarkIds.filter((v) => v !== id); if (this.cachedIndex.legacyBookmarks) this.cachedIndex.legacyBookmarks = this.cachedIndex.legacyBookmarks.filter((m) => m.messageId !== id); }
    for (const page of this.pages.values()) page.bookmarks = page.bookmarks.filter((m) => m.messageId !== id);
  }
  private removeCached(id: string): void {
    this.record({ kind: 'remove', id });
    const present = this.known.has(id) || this.cachedIndex?.bookmarkIds.includes(id) || this.cachedIndex?.reminders.some((m) => m.messageId === id);
    this.drop(id); if (present) this.changed(false);
  }
  private deleted(ids: string[]): void {
    this.record({ kind: 'deleted', ids });
    let changed = false;
    for (const row of this.known.values()) {
      if (row.available && ids.includes(row.messageId)) { row.available = false; changed = true; }
    }
    if (changed) this.changed(false);
  }
  /** Failed reads are latched until explicit Refresh; concurrent views share the same request. */
  private load<T>(key: string, refresh: boolean, run: () => Promise<T>): Promise<T> {
    const pending = this.pending.get(key); if (pending) return pending as Promise<T>;
    if (refresh) this.failures.delete(key);
    const failed = this.failures.get(key); if (failed) return Promise.reject(failed);
    const session = this.stamp().session;
    const pageGeneration = this.pageGeneration, cacheGeneration = this.cacheGeneration;
    const request = run().catch((error: unknown) => {
      const friendly = error instanceof DiscordHttpError && error.status === 404 ? new Error('Discord did not make saved messages available for this account. Use Refresh to retry, at most once per minute.') : error instanceof Error ? error : new Error(String(error));
      if (this.session === session && cacheGeneration === this.cacheGeneration && (!key.startsWith('page:') || pageGeneration === this.pageGeneration) && !(error instanceof SavedConflict)) { this.failures.set(key, friendly); if (key === 'index') this.ownerFailure = friendly; }
      throw friendly;
    }).finally(() => { if (this.pending.get(key) === request) this.pending.delete(key); });
    this.pending.set(key, request); return request;
  }
  async index(refresh: unknown = false): Promise<SavedIndex> {
    if (typeof refresh !== 'boolean') throw new Error('Not a saved-message refresh option.');
    const stamp = this.stamp();
    const force = refresh && !this.pending.has('index') && this.forceAllowed('index');
    if (force) { this.cachedIndex = null; this.cacheGeneration++; this.ownerFailure = null; this.refreshAt.set('page:', Date.now()); this.clearPages(true); }
    const decoded = this.cachedIndex ?? await this.load('index', force, async () => {
      const changes: CacheChange[] = []; this.readChanges.add(changes);
      const cacheGeneration = this.cacheGeneration;
      const verify = (): void => { this.stamp(stamp.session); if (cacheGeneration !== this.cacheGeneration) throw new SavedConflict('Saved-message cache was reset. Refresh to try again.'); };
      try {
        const row = decodeSavedIndex(await this.d.client.get<unknown>(PATH, { bookmark_ids: 'true' }, { retryServerErrors: false, verify }));
        verify();
        for (const change of changes) {
          if (change.kind === 'deleted') { [...row.reminders, ...(row.legacyBookmarks ?? [])].forEach((m) => { if (change.ids.includes(m.messageId)) m.available = false; }); continue; }
          const id = change.kind === 'save' ? change.row.messageId : change.id;
          row.reminders = row.reminders.filter((m) => m.messageId !== id); row.bookmarkIds = row.bookmarkIds.filter((v) => v !== id);
          if (row.legacyBookmarks) row.legacyBookmarks = row.legacyBookmarks.filter((m) => m.messageId !== id);
          if (change.kind === 'save') { if (change.row.dueAt) row.reminders.push(change.row); else { row.bookmarkIds.push(id); row.legacyBookmarks?.unshift(change.row); } }
        }
        this.cachedIndex = row;
        for (const id of this.known.keys()) if (!row.bookmarkIds.includes(id) && !row.reminders.some((m) => m.messageId === id)) this.known.delete(id);
        [...row.reminders, ...(row.legacyBookmarks ?? [])].forEach((m) => this.known.set(m.messageId, m)); return row;
      } finally { this.readChanges.delete(changes); }
    });
    this.stamp(stamp.session);
    const revision = this.revision, cacheGeneration = this.cacheGeneration;
    const cachedBookmarks = decoded.legacyBookmarks ?? [...this.known.values()].filter((m) => !m.dueAt && decoded.bookmarkIds.includes(m.messageId));
    const visible = await this.d.filter([...decoded.reminders, ...cachedBookmarks], decoded.bookmarkIds);
    const writableChannelIds = (await this.d.writable(this.accountId!)).sort();
    this.stamp(stamp.session); this.sameRevision(revision);
    if (cacheGeneration !== this.cacheGeneration) throw new SavedConflict('Saved-message cache was refreshed. Try again.');
    this.writableIds = writableChannelIds;
    if (this.accessDirty) this.accessChanged();
    return { session: stamp.session, revision, pageEpoch: this.pageGeneration, writableChannelIds, reminders: visible.items.filter((m) => m.dueAt !== null), bookmarkIds: visible.bookmarkIds,
      ...(decoded.legacyBookmarks === undefined ? {} : { legacyBookmarks: visible.items.filter((m) => m.dueAt === null) }) };
  }
  async bookmarks(value: unknown): Promise<SavedBookmarkPage> {
    const v = object(value), stamp = this.stamp(v.session);
    if (typeof v.session !== 'string') throw new Error('Refresh saved messages before loading another page.');
    if (v.refresh !== undefined && typeof v.refresh !== 'boolean') throw new Error('Not a bookmark refresh option.');
    const before = v.before === undefined ? undefined : savedTimestamp(v.before);
    if (before !== undefined && v.refresh) throw new Error('Refresh starts at the first bookmark page.');
    const key = before ?? '', requestKey = `page:${key}`;
    if (!this.cachedIndex) throw new Error('Load the saved-message index before its bookmark pages.');
    if (v.pageEpoch !== undefined && v.pageEpoch !== this.pageGeneration) throw new SavedConflict('Bookmark pages changed. Refresh the list.');
    if (before !== undefined && ![...this.pages.values()].some((p) => p.hasMore && p.nextBefore === before)) throw new Error('Not a cursor from the native bookmark list. Refresh saved messages.');
    const force = v.refresh === true && !this.pending.has(requestKey) && this.forceAllowed(requestKey);
    if (force && before === undefined && (this.pages.size || [...this.failures.keys()].some((k) => k.startsWith('page:')))) this.clearPages(true);
    if (this.cachedIndex.bookmarkIds.length === 0) return { ...stamp, pageEpoch: this.pageGeneration, bookmarks: [], hasMore: false, nextBefore: null };
    if (before === undefined && this.cachedIndex.legacyBookmarks) this.pages.set('', { bookmarks: this.cachedIndex.legacyBookmarks, hasMore: false, nextBefore: this.cachedIndex.legacyBookmarks.at(-1)?.savedAt ?? null });
    const pageGeneration = this.pageGeneration;
    const decoded = this.pages.get(key) ?? await this.load(requestKey, force, async () => {
      const changes: CacheChange[] = []; this.readChanges.add(changes);
      const verify = (): void => { this.stamp(stamp.session); if (pageGeneration !== this.pageGeneration) throw new SavedConflict('Bookmark pages were refreshed. Try again.'); };
      try {
        const row = decodeSavedPage(await this.d.client.get<unknown>(`${PATH}/bookmarks`, { before, limit: SAVED_BOOKMARK_PAGE_SIZE }, { retryServerErrors: false, verify }), before);
        verify();
        for (const change of changes) {
          if (change.kind === 'deleted') { row.bookmarks.forEach((m) => { if (change.ids.includes(m.messageId)) m.available = false; }); continue; }
          const id = change.kind === 'save' ? change.row.messageId : change.id, wasInPage = row.bookmarks.some((m) => m.messageId === id);
          row.bookmarks = row.bookmarks.filter((m) => m.messageId !== id);
          if (change.kind === 'save' && !change.row.dueAt && (wasInPage || before === undefined || (savedTimeOrder(change.row.savedAt) < savedTimeOrder(before) && (!row.nextBefore || savedTimeOrder(change.row.savedAt) >= savedTimeOrder(row.nextBefore))))) row.bookmarks.push(change.row);
        }
        row.bookmarks.sort((a, b) => savedTimeOrder(a.savedAt) > savedTimeOrder(b.savedAt) ? -1 : 1);
        this.pages.set(key, row); row.bookmarks.forEach((m) => this.known.set(m.messageId, m)); return row;
      } finally { this.readChanges.delete(changes); }
    });
    this.stamp(stamp.session);
    const revision = this.revision;
    const visible = await this.d.filter(decoded.bookmarks, []);
    this.stamp(stamp.session); this.sameRevision(revision);
    if (pageGeneration !== this.pageGeneration) throw new SavedConflict('Bookmark pages were refreshed. Try again.');
    return { session: stamp.session, revision, pageEpoch: this.pageGeneration, ...decoded, bookmarks: visible.items };
  }
  private target(value: unknown): SavedRemove {
    const v = object(value), target = savedTarget(v);
    if (typeof v.session !== 'string') throw new Error('Refresh saved messages before changing them.');
    if (!Number.isSafeInteger(v.revision) || (v.revision as number) < 0) throw new Error('Refresh saved messages before changing them.');
    this.stamp(v.session);
    this.sameRevision(v.revision as number);
    return { ...target, session: v.session, revision: v.revision as number };
  }
  private async hasSaved(target: SavedRemove): Promise<boolean> {
    const known = this.known.get(target.messageId);
    if (known) {
      if (savedKey(known) !== savedKey(target)) throw new Error('Saved message belongs to another channel.');
      return true;
    }
    // Core can link a bare id to an archived, privacy-visible original. An unknown id proves no channel.
    return !!this.cachedIndex?.bookmarkIds.includes(target.messageId) && (await this.d.filter([], [target.messageId])).bookmarkIds.includes(target.messageId);
  }
  private async guard(target: SavedRemove, dueAt?: string, existingRequired = false): Promise<void> {
    this.stamp(target.session);
    this.sameRevision(target.revision);
    if (!(await this.d.visible(target))) throw new Error('This message is hidden by privacy mode.');
    if (!this.cachedIndex) throw new Error('Refresh saved messages before changing them.');
    if (!(await this.hasSaved(target))) {
      if (existingRequired) throw new Error('This message is no longer saved. Refresh the list.');
      if (!(await this.d.writable(this.accountId!)).includes(target.channelId)) throw new Error('Discord no longer grants read-history access to this channel.');
    }
    this.stamp(target.session);
    this.sameRevision(target.revision);
    if (dueAt !== undefined) reminderTime(dueAt);
  }
  async save(value: unknown): Promise<void> {
    const v = object(value), target = this.target(value);
    if (!(SAVED_SOURCES as readonly unknown[]).includes(v.source)) throw new Error('Not a saved-message source.');
    const dueAt = v.dueAt === undefined ? undefined : reminderTime(v.dueAt);
    const write: SavedWrite = { ...target, source: v.source as SavedWrite['source'], ...(dueAt === undefined ? {} : { dueAt }) };
    await this.guard(target, dueAt, write.source === 'for_later_list');
    let privacy = this.privacyRevision;
    try {
      const row = decodeSavedMessage(await this.d.client.putJson<unknown>(itemPath(target), { ...(dueAt === undefined ? {} : { due_at: dueAt }), source: write.source }, {
        once: true, guard: async () => { const checked = this.privacyRevision; await this.guard(target, dueAt, write.source === 'for_later_list'); privacy = checked; },
        verify: () => { this.stamp(target.session); this.sameRevision(target.revision); if (privacy !== this.privacyRevision) throw new Error('Privacy changed. Refresh saved messages.'); if (dueAt !== undefined) reminderTime(dueAt); },
      }));
      this.stamp(target.session);
      if (savedKey(row) !== savedKey(target)) throw new Error('Discord returned a different saved message. Refresh the list to check the result.');
      if ((row.dueAt === null) !== (dueAt === undefined)) throw new Error('Discord returned a different saved-message kind. Refresh the list to check the result.');
      this.upsert(row);
    } catch (err) {
      if (err instanceof DiscordHttpError && err.code === SAVED_LIMIT_CODE) throw new Error('Discord’s saved-message limit was reached. Remove a bookmark or reminder and try again.');
      throw err;
    }
  }
  async remove(value: unknown): Promise<void> {
    const target = this.target(value);
    await this.guard(target, undefined, true);
    let privacy = this.privacyRevision;
    await this.d.client.delete(itemPath(target), { once: true,
      guard: async () => { const checked = this.privacyRevision; await this.guard(target, undefined, true); privacy = checked; },
      verify: () => { this.stamp(target.session); this.sameRevision(target.revision); if (privacy !== this.privacyRevision) throw new Error('Privacy changed. Refresh saved messages.'); },
    });
    this.stamp(target.session);
    this.removeCached(target.messageId);
  }
}
