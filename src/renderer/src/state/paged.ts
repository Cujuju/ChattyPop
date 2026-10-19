import type { ArchiveChangeSet } from '@plugin-sdk/renderer/archiveChangeSet';
import { batchWrites, createStore } from '@plugin-sdk/renderer/containment';
import type { Accessor, Setter } from 'solid-js';
import { reconcile, unwrap } from 'solid-js/store';

/** Matches refetched list items by id to retain objects and For rows, preserving focus/scroll position. */
export function keyedById<T extends { id: string | number }>(init: T[] | undefined): [Accessor<T[]>, Setter<T[] | undefined>] {
  const [store, setStore] = createStore<{ items: T[] }>({ items: init ?? [] });
  const set = (v?: T[] | ((prev: T[]) => T[] | undefined)): T[] => {
    const next = typeof v === 'function' ? v(unwrap(store.items)) : v;
    setStore('items', reconcile(next ?? [], { key: 'id' }));
    return store.items;
  };
  return [() => store.items, set as Setter<T[] | undefined>];
}

/** Rows oldest first (newest at the bottom); `reachedStart` once the oldest row is loaded. */
export interface PagedState<T> {
  items: T[];
  loading: boolean;
  reachedStart: boolean;
}

/** Rows an update leaves, and whether the oldest of them is the oldest there is. */
export interface Updated<T> {
  items: T[];
  reachedStart: boolean;
}

export interface PagedChangeOptions<T> {
  /** True only for newest-by-date ordering at the live end of the list. */
  chronological?: () => boolean;
  newestAtStart?: () => boolean;
  /** Descending Person lists page older rows from the last visual row. */
  oldestAtEnd?: boolean;
  atNewest?: () => boolean;
  newer?: (newest: T, signal?: AbortSignal) => Promise<T[]>;
  reload?: (signal?: AbortSignal) => Promise<unknown>;
}

export interface PagedList<T> {
  state: PagedState<T>;
  /** Inserts read past the newest cursor; other changes reload the first page. */
  applyChange(change: ArchiveChangeSet, signal?: AbortSignal): Promise<void>;
  /** Replaces rows from fetch results; superseded reloads return false without changes. */
  reload(fetch: (signal?: AbortSignal) => Promise<{ items: T[]; reachedStart: boolean }>, signal?: AbortSignal): Promise<boolean>;
  /** Prepends the previous (older) page; resolves with how many rows were added (the view keeps its scroll anchor). */
  loadOlder(): Promise<number>;
  /** Appends newer pages and returns length; short pages reach newest. Returns null for missing fetchers, active loads or superseded reads. */
  loadNewer(): Promise<number | null>;
  /**
   * Applies fetched updates against current rows while preserving ids. Newer reloads/applied updates supersede stale
   * results with false. `apply` returns the rows, or the rows and whether they now reach the start (a reread of the
   * loaded span learns it too).
   */
  update<R>(fetch: (signal?: AbortSignal) => Promise<R>, apply: (result: R, items: readonly T[]) => T[] | Updated<T>): Promise<boolean>;
  /** Replaces the rows in place, keeping row identity by id; only for rows already in hand (no read since). */
  setItems(items: T[]): void;
  /** Clears a scope immediately and invalidates every in-flight page, including while its view is hidden. */
  reset(): void;
}

/** Loads chronological lists newest page first. Generation tokens discard superseded pages/updates after filter, channel or privacy changes. */
export function createPagedList<T extends { id: string | number }>(
  pageSize: number,
  fetchOlder: (oldest: T, signal?: AbortSignal) => Promise<T[]>,
  fetchNewer?: (newest: T, signal?: AbortSignal) => Promise<T[]>,
  changeOptions: PagedChangeOptions<T> = {},
): PagedList<T> {
  const [state, setState] = createStore<PagedState<T>>({ items: [], loading: false, reachedStart: false });
  let generation = 0;
  let controller = new AbortController();
  /** Earlier updates cannot overwrite later applied reads. */
  let updates = 0;
  let appliedUpdate = 0;

  // Each direction loads on its own: a page of older rows in flight never holds up newer ones (or the reverse).
  let reloading = false;
  let olderBusy = false;
  let newerBusy = false;
  const showLoading = (): void => void setState('loading', reloading || olderBusy || newerBusy);

  let lastReload: ((signal?: AbortSignal) => Promise<Updated<T>>) | undefined;
  const reload: PagedList<T>['reload'] = async (fetch, signal) => {
    controller.abort();
    controller = new AbortController();
    const readSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    lastReload = fetch;
    const mine = ++generation;
    reloading = true;
    olderBusy = newerBusy = false;
    showLoading();
    try {
      const r = await fetch(readSignal);
      if (mine !== generation) return false;
      readSignal.throwIfAborted();
      setState({ items: r.items, reachedStart: r.reachedStart });
      return true;
    } finally {
      if (mine === generation) {
        reloading = false;
        showLoading();
      }
    }
  };

  const loadOlder = async (): Promise<number> => {
    const atStart = changeOptions.oldestAtEnd ?? false;
    const oldest = atStart ? state.items.at(-1) : state.items[0];
    if (!oldest || reloading || olderBusy || state.reachedStart) return 0;
    const mine = generation;
    olderBusy = true;
    showLoading();
    try {
      const page = await fetchOlder(oldest, controller.signal);
      if (mine !== generation) return 0;
      setState({ items: atStart ? [...state.items, ...page] : [...page, ...state.items], reachedStart: page.length < pageSize });
      return page.length;
    } finally {
      if (mine === generation) {
        olderBusy = false;
        showLoading();
      }
    }
  };

  const loadNewer = async (): Promise<number | null> => {
    const newest = state.items.at(-1);
    if (!fetchNewer || !newest || reloading || newerBusy) return null;
    const mine = generation;
    newerBusy = true;
    showLoading();
    try {
      const page = await fetchNewer(newest, controller.signal);
      if (mine !== generation) return null;
      // An in-place refresh may have added some of these meanwhile.
      const have = new Set(state.items.map((i) => i.id));
      setState('items', [...state.items, ...page.filter((i) => !have.has(i.id))]);
      return page.length;
    } finally {
      if (mine === generation) {
        newerBusy = false;
        showLoading();
      }
    }
  };

  const setItems = (items: T[]): void => void setState('items', reconcile(items, { key: 'id' }));

  const update: PagedList<T>['update'] = async (fetch, apply) => {
    const mine = generation;
    const turn = ++updates;
    const result = await fetch(controller.signal);
    if (mine !== generation || turn < appliedUpdate) return false;
    appliedUpdate = turn;
    const next = apply(result, state.items);
    if (Array.isArray(next)) setItems(next);
    else batchWrites(() => { setItems(next.items); setState('reachedStart', next.reachedStart); });
    return true;
  };

  const applyChange = async (change: ArchiveChangeSet, signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    const insertOnly = change.channelIds.size > 0 && [...change.channelIds].every((id) => id !== '' && change.insertOnly(id));
    if (insertOnly && changeOptions.atNewest?.() === false) return;
    const newer = changeOptions.newer ?? fetchNewer;
    if (!insertOnly || changeOptions.chronological?.() === false || !newer || !state.items.length) {
      if (changeOptions.reload) await changeOptions.reload(signal);
      else if (lastReload) await reload(lastReload, signal);
      return;
    }
    const mine = generation;
    let added: number;
    do {
      const atStart = changeOptions.newestAtStart?.() ?? false;
      const newest = atStart ? state.items[0]! : state.items.at(-1)!;
      const readSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const page = await newer(newest, readSignal);
      if (mine !== generation) return;
      readSignal.throwIfAborted();
      const cursor = JSON.stringify(newest);
      const incoming = new Set(page.map((row) => row.id));
      const kept = state.items.filter((row) => !incoming.has(row.id));
      setItems(atStart ? [...page, ...kept] : [...kept, ...page]);
      added = page.length;
      // A source returning an unchanged full page must not spin indefinitely.
      if (JSON.stringify(atStart ? state.items[0] : state.items.at(-1)) === cursor) return;
    } while (added === pageSize);
  };

  const reset = (): void => {
    controller.abort();
    controller = new AbortController();
    generation++;
    reloading = olderBusy = newerBusy = false;
    setState({ items: [], loading: false, reachedStart: false });
  };
  return { state, reload, loadOlder, loadNewer, update, setItems, applyChange, reset };
}
