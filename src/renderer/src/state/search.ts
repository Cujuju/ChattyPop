import { api } from '@/api';
import { createSignal } from 'solid-js';
import type { SearchHit } from '@shared/contract';
import { DEFAULT_SEARCH_SORT, normalizeSavedSearches, normalizeSearchSort, type SearchSort } from '@shared/searchQuery';
import { SETTINGS_KEYS } from '@shared/settings';
import { onAppEvent } from './events';
import { createSetting } from '@plugin-sdk/renderer/settings';

/** Results shown in the top-bar dropdown. */
const RESULT_LIMIT = 30;
/** Wait for a pause in typing before querying. */
const QUERY_DEBOUNCE_MS = 150;
/**
 * Plugins' search rankers (ctx.search.rerank; Jev re-rank) run only after a longer pause, when the query is likely
 * finished: one request per search, not per keystroke.
 */
const RANK_PAUSE_MS = 1000;

export const [searchText, setSearchText] = createSignal('');
export const [searchHits, setSearchHits] = createSignal<SearchHit[]>([]);
/** The dropdown is open (it covers the chat area, so the native Discord view must hide). */
export const [searchOpen, setSearchOpen] = createSignal(false);
/** The results' order; Relevance alone lets plugins' search rankers reorder them. */
export const [searchSort, storeSearchSort] = createSetting<SearchSort>(SETTINGS_KEYS.searchSort, DEFAULT_SEARCH_SORT, normalizeSearchSort);
/** Bumped to move focus into the search field (frame/Search follows it). */
export const [searchFocusRequests, setSearchFocusRequests] = createSignal(0);

/** The search shortcut: opens the panel first, so a shell that puts the field away until then (the phone) shows it, then focuses it. */
export function focusSearch(): void {
  setSearchOpen(true);
  setSearchFocusRequests((n) => n + 1);
}

let timer: ReturnType<typeof setTimeout> | undefined;
let rankTimer: ReturnType<typeof setTimeout> | undefined;
/** The latest query's ticket: an answer to any earlier one, cleared ones included, is dropped. */
let latest = 0;

/**
 * Updates the query: full-text results arrive in the chosen order after a short pause and show at once; sorted by
 * relevance, after a longer one the active rankers may reorder them. Answers to a query no longer the latest are dropped; a ranker's failure keeps the order.
 */
export function querySearch(text: string): void {
  setSearchText(text);
  clearTimeout(timer);
  clearTimeout(rankTimer);
  const ticket = ++latest;
  if (!text.trim()) {
    setSearchHits([]);
    return;
  }
  const sort = searchSort();
  timer = setTimeout(() => {
    void api.core.searchMessages(text, RESULT_LIMIT, sort).then((hits) => {
      if (ticket !== latest) return;
      setSearchHits(hits);
      if (sort !== 'relevance' || hits.length < 2) return; // a time order stands; one hit has nothing to reorder
      rankTimer = setTimeout(() => {
        void api.core.rankSearch(text, hits).then(
          (ranked) => void (ranked && ticket === latest && setSearchHits(ranked)),
          () => undefined, // keep the full-text order
        );
      }, RANK_PAUSE_MS);
    });
  }, QUERY_DEBOUNCE_MS);
}

/** Changes the results' order and searches again in it. */
export function setSearchSort(sort: SearchSort): void {
  storeSearchSort(sort);
  if (searchText().trim()) querySearch(searchText());
}

export const [savedSearches, setSavedSearches] = createSetting<string[]>(SETTINGS_KEYS.savedSearches, [], normalizeSavedSearches);

export const isSavedSearch = (query: string): boolean => savedSearches().includes(query.trim());

/** Saves the query (newest first), or removes it when already saved. */
export function toggleSavedSearch(query: string): void {
  const q = query.trim();
  if (!q) return;
  setSavedSearches(isSavedSearch(q) ? savedSearches().filter((s) => s !== q) : [q, ...savedSearches()]);
}

// Privacy mode changed: results may be hidden or back.
onAppEvent('privacy-changed', () => {
  if (searchText().trim()) querySearch(searchText());
});
