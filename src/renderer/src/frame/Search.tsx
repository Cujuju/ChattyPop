// Archive search field and its panel: the query builder, a filter's value picker, or results with operator feedback.
import { For, Match, Show, Switch, createEffect, createMemo, createResource, on } from 'solid-js';
import { SegButton, SegGroup } from '@cujuju/solidjs-seg-buttons';
import type { SearchHit } from '@shared/contract';
import { searchTokens } from '@/plugins/slots';
import { SEARCH_SORTS, parseSearchQuery, type SearchSort } from '@shared/searchQuery';
import { openArchive } from '@/state/archive';
import { choicesRevision, isSavedSearch, querySearch, savedSearches, showSearch, searchFocusRequests, searchHits, searchOpen, searchSort, searchText, setSearchOpen, setSearchSort, toggleSavedSearch } from '@/state/search';
import { inCompanion } from '@/state/ui';
import { listen } from '@/ui/listen';
import { createListNav } from '@/ui/listNav';
import { chipChoice, namedChoiceSources, rememberChoice } from './searchChoices';
import { joinQuery, pendingFilter, searchFilters, splitQuery, withChoice, withFilter, type FilterChoice, type PendingFilter, type QueryChip } from './searchFilters';
import { SearchChips } from './SearchChips';
import { AddFilterStrip, FilterList, ValuePicker } from './SearchBuilder';
import { SearchHits } from './SearchResults';
import { Icon } from '@/ui/icons';
import styles from './Search.module.css';

const SORT_LABELS: Readonly<Record<SearchSort, string>> = { newest: 'Newest', oldest: 'Oldest', relevance: 'Relevance' };

/** The choices offered for one pending value. */
interface OfferedChoices {
  pending: PendingFilter;
  list: readonly FilterChoice[];
  /** choicesRevision when asked: a list from before a privacy change is never shown. */
  revision: number;
}

/** Choices for `pending`, now when its filter has them at hand, else when they arrive (people). */
function offeredChoices(pending: PendingFilter): OfferedChoices | Promise<OfferedChoices> {
  const revision = choicesRevision();
  const list = pending.filter.choices(pending.partial);
  return list instanceof Promise ? list.then((l) => ({ pending, list: l, revision })) : { pending, list, revision };
}

/** The same chips, term for term: the field keeps them (and their looked-up names) while only the draft changes. */
const sameChips = (a: readonly QueryChip[], b: readonly QueryChip[]): boolean => a.length === b.length && a.every((c, i) => c.raw === b[i]!.raw);

/** Leader then / focuses archive search. Empty queries show filters/saved searches; a `key:` being typed offers matching values; results open Archive messages. */
export function Search() {
  let input!: HTMLInputElement;
  let root!: HTMLDivElement;
  let query!: HTMLDivElement;
  const filters = createMemo(() => searchFilters(searchTokens(), namedChoiceSources));
  // A privacy change asks again for the same text.
  const pending = createMemo(() => (choicesRevision(), pendingFilter(searchText(), filters())));
  const [offered] = createResource(pending, offeredChoices);
  /** The latest choices for the filter being typed; while newer ones load, the previous list stays to avoid a flash. */
  const choices = (): readonly FilterChoice[] => {
    const o = offered.error ? undefined : offered.latest;
    return o && o.pending.filter === pending()?.filter && o.revision === choicesRevision() ? o.list : [];
  };
  /** Only choices for exactly what is typed now may be picked. */
  const current = (): boolean => !offered.error && offered.latest?.pending === pending();
  /** A pending value shows its picker until it is typed and matches nothing, when its results show instead. */
  const picking = (): boolean => {
    const p = pending();
    return !!p && (p.partial === '' || choices().length > 0 || (offered.loading && !!p.filter.named));
  };
  const mode = (): 'filters' | 'value' | 'results' => (searchText().trim() === '' ? 'filters' : picking() ? 'value' : 'results');
  const pick = (choice: FilterChoice | undefined): void => {
    const p = pending();
    if (!p || !choice || !current()) return;
    rememberChoice(p.filter.key, choice);
    edit(withChoice(searchText(), p, choice));
  };
  const pluginKeys = createMemo(() => searchTokens().map((t) => t.key));
  const problems = () => parseSearchQuery(searchText(), pluginKeys()).problems;
  /** The query as the field shows it: finished filters as chips, then the draft typed in the input. */
  const split = createMemo(() => splitQuery(searchText(), pluginKeys()));
  const chips = createMemo(() => split().chips, undefined, { equals: sameChips });
  const draft = (): string => split().draft;
  const removeChip = (chip: QueryChip): void => edit(joinQuery(chips().filter((c) => c !== chip), draft()));
  const choiceFor = (chip: QueryChip) => chipChoice(chip, filters().find((f) => f.key === chip.key), chips());
  /** Typing sets the draft; a term it finishes moves into a chip, so the input then shows the draft alone. */
  const onDraft = (el: HTMLInputElement): void => {
    edit(joinQuery(chips(), el.value));
    if (el.value !== draft()) el.value = draft();
  };
  /** Backspace at the draft's start removes the last chip, as Discord's does. */
  const onBackspace = (e: KeyboardEvent): void => {
    if (e.key !== 'Backspace' || input.selectionStart !== 0 || input.selectionEnd !== 0 || !chips().length) return;
    e.preventDefault();
    removeChip(chips().at(-1)!);
  };
  // A new chip may overflow the field: keep the draft in view.
  createEffect(on(chips, () => (query.scrollLeft = query.scrollWidth), { defer: true }));
  /** Replaces the query, keeping the field focused and the panel open. */
  const edit = (query: string): void => {
    querySearch(query);
    setActive(0);
    setSearchOpen(true);
    input.focus();
  };
  /** Runs a saved search, by Enter or a click alike: its filters finished as chips. */
  const openSaved = (query: string): void => {
    showSearch(query);
    setActive(0);
  };
  /** Closes the panel (the phone puts the field away too). */
  const close = (): void => {
    setSearchOpen(false);
    input.blur();
  };
  const open = (hit: SearchHit | undefined): void => {
    if (!hit) return;
    void openArchive(hit.channelId, hit.messageId);
    close();
  };
  const rowCount = (): number => {
    if (mode() === 'filters') return filters().length + savedSearches().length;
    if (mode() === 'value') return choices().length;
    return searchHits().length;
  };
  const { active, setActive, onKey } = createListNav(rowCount, {
    onEnter: (i) => {
      if (mode() === 'results') open(searchHits()[i]);
      else if (mode() === 'value') pick(choices()[i]);
      else if (i < filters().length) edit(withFilter(searchText(), filters()[i]!.key));
      else if (savedSearches()[i - filters().length]) openSaved(savedSearches()[i - filters().length]!);
    },
    onEscape: close,
    activeEl: () => document.getElementById(`search-row-${active()}`),
  });
  const nav = { active, setActive };
  // The search shortcut (state/shortcuts.ts) asks for focus.
  createEffect(on(searchFocusRequests, () => input.focus(), { defer: true }));
  // Outside focus/press closes search. Desktop blur-to-nowhere closes; phone keyboard dismissal keeps results available.
  const onFocusOut = (e: FocusEvent): void => {
    const to = e.relatedTarget as Node | null;
    if (to ? !root.contains(to) : !inCompanion) setSearchOpen(false);
  };
  listen(window, 'pointerdown', (e) => searchOpen() && !root.contains(e.target as Node) && setSearchOpen(false), true);

  return (
    <div ref={root} class={styles.root} onFocusOut={onFocusOut}>
      <label for="archive-search" class="cp-visually-hidden">
        Search the archive
      </label>
      {/* A press on the field's ground or a chip types into the draft; buttons keep their own presses. */}
      <div class={`cp-stroke ${styles.field}`} onMouseDown={(e) => e.target !== input && !(e.target as Element).closest('button') && (e.preventDefault(), input.focus())}>
        {/* Magnifier toggles search on mousedown before blur and preserves field focus. Escape closes keyboard search. */}
        <button
          type="button"
          class={styles.icon}
          tabIndex={-1}
          aria-label={searchOpen() ? 'Close search' : 'Search the archive'}
          onMouseDown={(e) => {
            e.preventDefault();
            if (searchOpen()) close();
            else input.focus();
          }}
        >
          <Icon name="search" />
        </button>
        <div ref={query} class={styles.query}>
          <SearchChips id="archive-search-filters" chips={chips()} choice={choiceFor} onRemove={removeChip} />
          <input
            ref={input}
            id="archive-search"
            class={styles.input}
            type="search"
            placeholder={chips().length ? undefined : 'Search the archive'}
            autocomplete="off"
            role="combobox"
            aria-expanded={searchOpen()}
            aria-controls="archive-search-results"
            aria-activedescendant={searchOpen() && rowCount() ? `search-row-${active()}` : undefined}
            aria-describedby={chips().length ? 'archive-search-filters' : undefined}
            value={draft()}
            onInput={(e) => onDraft(e.currentTarget)}
            onFocus={() => setSearchOpen(true)}
            onKeyDown={(e) => (onBackspace(e), onKey(e))}
          />
        </div>
        <Show when={mode() !== 'filters'}>
          <button
            type="button"
            class={styles.save}
            aria-pressed={isSavedSearch(searchText())}
            title={isSavedSearch(searchText()) ? 'Remove from saved searches' : 'Save this search'}
            // mousedown, not click: keeps focus (and the panel) in the field.
            onMouseDown={(e) => {
              e.preventDefault();
              toggleSavedSearch(searchText());
            }}
          >
            <Icon name="star" />
          </button>
        </Show>
      </div>
      <Show when={searchOpen()}>
        <ul id="archive-search-results" class={`cp-popover ${styles.results}`} role="listbox" aria-label={mode() === 'results' ? 'Search results' : 'Search filters'}>
          <Switch>
            <Match when={mode() === 'filters'}>
              <FilterList
                {...nav}
                filters={filters()}
                saved={savedSearches()}
                onFilter={(f) => edit(withFilter(searchText(), f.key))}
                onSaved={openSaved}
                onRemoveSaved={toggleSavedSearch}
              />
            </Match>
            <Match when={mode() === 'value' && pending()}>{(p) => <ValuePicker {...nav} pending={p()} choices={choices()} onPick={pick} />}</Match>
            <Match when={mode() === 'results'}>
              <AddFilterStrip filters={filters()} onFilter={(f) => edit(withFilter(searchText(), f.key))} />
              {/* mousedown kept from the buttons: focus (and the panel) stays in the field. */}
              <li class={styles.sort} role="presentation" onMouseDown={(e) => e.preventDefault()}>
                <SegGroup role="radiogroup" ariaLabel="Sort results" value={searchSort()} onChange={setSearchSort}>
                  <For each={SEARCH_SORTS}>{(s) => <SegButton value={s} label={SORT_LABELS[s]} size="xs" />}</For>
                </SegGroup>
              </li>
              <For each={problems()}>
                {(p) => (
                  <li class={styles.problem} role="presentation">
                    <code>{p.raw}</code> ignored: {p.reason}
                  </li>
                )}
              </For>
              <Show when={searchHits().some((h) => h.relevance !== undefined)}>
                <li class={styles.heading} role="presentation" title="Jev's estimate of which results answer the query; a model's guess">
                  Top results ordered by Jev
                </li>
              </Show>
              <Show when={searchHits().length} fallback={<li class={styles.empty}>No matches</li>}>
                <SearchHits {...nav} hits={searchHits()} onOpen={open} />
              </Show>
            </Match>
          </Switch>
        </ul>
      </Show>
    </div>
  );
}
