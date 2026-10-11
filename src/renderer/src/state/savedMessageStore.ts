// Account/revision fencing is independent of Solid and the transport so it can be contract-tested.
import type { RendererApi } from '@shared/rendererApi';
import { savedKey, type SavedMessage } from '@shared/savedMessages';

export interface SavedState {
  session: string | null;
  revision: number;
  pageEpoch: number;
  bookmarks: SavedMessage[];
  reminders: SavedMessage[];
  bookmarkIds: string[];
  writableChannelIds: string[];
  hasMore: boolean;
  nextBefore: string | null;
  stale: boolean;
  loading: boolean;
  paging: boolean;
  error: string;
  bookmarksLoaded: boolean;
  indexReadFailed: boolean;
}
const empty = (): SavedState => ({ session: null, revision: 0, pageEpoch: 0, bookmarks: [], reminders: [], bookmarkIds: [], writableChannelIds: [], hasMore: false, nextBefore: null, stale: true, loading: false, paging: false, error: '', bookmarksLoaded: false, indexReadFailed: false });
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
type SavedApi = Pick<RendererApi['discord'], 'savedMessages' | 'savedBookmarks'>;

export class SavedMessageStore {
  state = empty();
  private generation = 0;
  private pending: Promise<void> | null = null;
  private rerun: { force: boolean; includeBookmarks: boolean } | null = null;
  private pendingGeneration = 0;
  private pendingOptions = { force: false, includeBookmarks: true };
  private readStarted = false;
  get hasReadSinceReset(): boolean { return this.readStarted; }
  constructor(private readonly api: SavedApi, private readonly changed: (state: SavedState) => void) {}
  private set(patch: Partial<SavedState>): void { this.state = { ...this.state, ...patch }; this.changed(this.state); }
  invalidate(session: string | null, revision: number, reset: boolean, pageEpoch = this.state.pageEpoch): void {
    if (session === this.state.session && revision < this.state.revision) return;
    this.generation++;
    const clear = reset || session !== this.state.session;
    if (clear) { this.rerun = null; this.readStarted = false; }
    // Keep the old epoch until a matching index/page is adopted, so refresh discards deeper pages.
    this.set({ ...(clear ? empty() : {}), session, revision, stale: true, loading: this.pending !== null, paging: false,
      ...(pageEpoch !== this.state.pageEpoch ? { hasMore: false, nextBefore: null } : {}) });
  }
  clear(): void { this.generation++; this.rerun = null; this.readStarted = false; this.set({ ...empty(), loading: this.pending !== null }); }
  refresh(force = false, includeBookmarks = true): Promise<void> {
    this.readStarted = true;
    if (this.pending) {
      if (this.pendingGeneration !== this.generation || (force && !this.pendingOptions.force) || (includeBookmarks && !this.pendingOptions.includeBookmarks))
        this.rerun = { force: (force && !this.pendingOptions.force) || (this.rerun?.force ?? false), includeBookmarks: includeBookmarks || this.pendingOptions.includeBookmarks || (this.rerun?.includeBookmarks ?? false) };
      return this.pending;
    }
    const generation = ++this.generation;
    this.pendingGeneration = generation;
    this.pendingOptions = { force, includeBookmarks };
    this.set({ loading: true, paging: false, error: '' });
    const run = async (): Promise<void> => {
      try {
        const index = await this.api.savedMessages(force);
        if (generation !== this.generation || (index.session === this.state.session && index.revision < this.state.revision)) return;
        if (index.session !== this.state.session) this.set({ ...empty(), session: index.session, revision: index.revision, loading: true });
        const page = includeBookmarks && index.legacyBookmarks === undefined ? await this.api.savedBookmarks({ session: index.session, pageEpoch: index.pageEpoch, ...(force ? { refresh: true } : {}) }) : null;
        if (generation !== this.generation) return;
        if (page && (page.session !== index.session || page.revision !== index.revision || page.pageEpoch !== index.pageEpoch)) throw new Error('Saved messages changed while loading. Refresh to try again.');
        const loaded = index.legacyBookmarks !== undefined || page !== null;
        const initial = index.legacyBookmarks ?? page?.bookmarks ?? [];
        const samePages = index.pageEpoch === this.state.pageEpoch;
        const preserveMore = !force && samePages && this.state.bookmarksLoaded && loaded;
        const keepCursor = preserveMore || (!loaded && samePages);
        const incoming = preserveMore ? [...initial, ...this.state.bookmarks.filter((m) => index.bookmarkIds.includes(m.messageId) && !initial.some((v) => savedKey(v) === savedKey(m)))] : initial;
        const stable = (items: SavedMessage[], previous: SavedMessage[]): SavedMessage[] => items.map((m) => previous.find((p) => savedKey(p) === savedKey(m) && JSON.stringify(p) === JSON.stringify(m)) ?? m);
        const bookmarks = loaded ? stable(incoming, this.state.bookmarks) : samePages ? this.state.bookmarks.filter((m) => index.bookmarkIds.includes(m.messageId)) : [];
        this.set({ session: index.session, revision: index.revision, pageEpoch: index.pageEpoch, writableChannelIds: index.writableChannelIds, indexReadFailed: index.indexReadFailed === true,
          reminders: stable([...index.reminders].sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!)), this.state.reminders),
          bookmarks, bookmarkIds: [...new Set([...index.bookmarkIds, ...bookmarks.map((m) => m.messageId)])],
          hasMore: keepCursor ? this.state.hasMore : page?.hasMore ?? false, nextBefore: keepCursor ? this.state.nextBefore : page?.nextBefore ?? null, stale: false, error: '', bookmarksLoaded: (samePages && this.state.bookmarksLoaded) || loaded });
      } catch (error) { if (generation === this.generation) this.set({ error: errorText(error), stale: true }); }
    };
    this.pending = run().finally(() => {
      this.pending = null;
      this.set({ loading: false });
      const rerun = this.rerun; this.rerun = null;
      if (rerun) return this.refresh(rerun.force, rerun.includeBookmarks);
    });
    return this.pending;
  }
  async loadMore(): Promise<void> {
    const { session, revision, pageEpoch, nextBefore, hasMore } = this.state;
    if (!session || !nextBefore || !hasMore || this.state.loading || this.state.paging || this.state.stale) return;
    const generation = this.generation;
    this.set({ paging: true, error: '' });
    try {
      const page = await this.api.savedBookmarks({ session, pageEpoch, before: nextBefore });
      if (generation !== this.generation) return;
      if (page.session !== session || page.revision !== revision || page.pageEpoch !== pageEpoch) throw new Error('Saved messages changed. Refresh before loading more.');
      const merged = new Map(this.state.bookmarks.map((m) => [savedKey(m), m]));
      page.bookmarks.forEach((m) => merged.set(savedKey(m), m));
      this.set({ bookmarks: [...merged.values()], bookmarkIds: [...new Set([...this.state.bookmarkIds, ...page.bookmarks.map((m) => m.messageId)])], hasMore: page.hasMore, nextBefore: page.nextBefore });
    } catch (error) { if (generation === this.generation) this.set({ error: errorText(error), stale: true }); }
    finally { if (generation === this.generation) this.set({ paging: false }); }
  }
}
