import type { Accessor, Setter } from 'solid-js';
import { createStore, reconcile, unwrap } from 'solid-js/store';

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

export interface PagedList<T> {
  state: PagedState<T>;
  /** Replaces rows from fetch results; superseded reloads return false without changes. */
  reload(fetch: () => Promise<{ items: T[]; reachedStart: boolean }>): Promise<boolean>;
  /** Prepends the previous (older) page; resolves with how many rows were added (the view keeps its scroll anchor). */
  loadOlder(): Promise<number>;
  /** Appends newer pages and returns length; short pages reach newest. Returns null for missing fetchers, active loads or superseded reads. */
  loadNewer(): Promise<number | null>;
  /** Applies fetched updates against current rows while preserving ids. Newer reloads/applied updates supersede stale results with false. */
  update<R>(fetch: () => Promise<R>, apply: (result: R, items: readonly T[]) => T[]): Promise<boolean>;
  /** Replaces the rows in place, keeping row identity by id; only for rows already in hand (no read since). */
  setItems(items: T[]): void;
}

/** Loads chronological lists newest page first. Generation tokens discard superseded pages/updates after filter, channel or privacy changes. */
export function createPagedList<T extends { id: string | number }>(
  pageSize: number,
  fetchOlder: (oldest: T) => Promise<T[]>,
  fetchNewer?: (newest: T) => Promise<T[]>,
): PagedList<T> {
  const [state, setState] = createStore<PagedState<T>>({ items: [], loading: false, reachedStart: false });
  let generation = 0;
  /** Earlier updates cannot overwrite later applied reads. */
  let updates = 0;
  let appliedUpdate = 0;

  // Each direction loads on its own: a page of older rows in flight never holds up newer ones (or the reverse).
  let reloading = false;
  let olderBusy = false;
  let newerBusy = false;
  const showLoading = (): void => void setState('loading', reloading || olderBusy || newerBusy);

  const reload: PagedList<T>['reload'] = async (fetch) => {
    const mine = ++generation;
    reloading = true;
    olderBusy = newerBusy = false;
    showLoading();
    try {
      const r = await fetch();
      if (mine !== generation) return false;
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
    const oldest = state.items[0];
    if (!oldest || reloading || olderBusy || state.reachedStart) return 0;
    const mine = generation;
    olderBusy = true;
    showLoading();
    try {
      const page = await fetchOlder(oldest);
      if (mine !== generation) return 0;
      setState({ items: [...page, ...state.items], reachedStart: page.length < pageSize });
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
      const page = await fetchNewer(newest);
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
    const result = await fetch();
    if (mine !== generation || turn < appliedUpdate) return false;
    appliedUpdate = turn;
    setItems(apply(result, state.items));
    return true;
  };

  return { state, reload, loadOlder, loadNewer, update, setItems };
}
