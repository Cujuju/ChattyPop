// The search list's rows: the query builder, a filter's value picker, or results with operator feedback.
import { For, Match, Show, Switch } from 'solid-js';
import { SegButton, SegGroup } from '@cujuju/solidjs-seg-buttons';
import { SEARCH_SORTS, type SearchSort } from '@shared/searchQuery';
import { savedSearches, searchHits, searchSort, searchText, setSearchSort, toggleSavedSearch } from '@/state/search';
import { withFilter } from './searchFilters';
import { AddFilterStrip, FilterList, ValuePicker } from './SearchBuilder';
import { SearchHits } from './SearchResults';
import type { SearchController } from './searchController';
import styles from './Search.module.css';

const SORT_LABELS: Readonly<Record<SearchSort, string>> = { newest: 'Newest', oldest: 'Oldest', relevance: 'Relevance' };

/** The listbox `archive-search-results`, which the field's combobox controls. Callers give it its place (dropdown or panel body). */
export function SearchBody(props: { search: SearchController; class?: string }) {
  const s = props.search;
  const nav = { active: s.active, setActive: s.setActive };
  return (
    <ul id="archive-search-results" class={`${styles.list} ${props.class ?? ''}`} role="listbox" aria-label={s.mode() === 'results' ? 'Search results' : 'Search filters'}>
      <Switch>
        <Match when={s.mode() === 'filters'}>
          <FilterList
            {...nav}
            filters={s.filters()}
            saved={savedSearches()}
            onFilter={(f) => s.edit(withFilter(searchText(), f.key))}
            onSaved={s.openSaved}
            onRemoveSaved={toggleSavedSearch}
          />
        </Match>
        <Match when={s.mode() === 'value' && s.pending()}>{(p) => <ValuePicker {...nav} pending={p()} choices={s.choices()} onPick={s.pick} />}</Match>
        <Match when={s.mode() === 'results'}>
          <AddFilterStrip filters={s.filters()} onFilter={(f) => s.edit(withFilter(searchText(), f.key))} />
          {/* mousedown kept from the buttons: focus (and the list) stays in the field. */}
          <li class={styles.sort} role="presentation" onMouseDown={(e) => e.preventDefault()}>
            <SegGroup role="radiogroup" ariaLabel="Sort results" value={searchSort()} onChange={setSearchSort}>
              <For each={SEARCH_SORTS}>{(sort) => <SegButton value={sort} label={SORT_LABELS[sort]} size="xs" />}</For>
            </SegGroup>
          </li>
          <For each={s.problems()}>
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
            <SearchHits {...nav} hits={searchHits()} onOpen={s.open} />
          </Show>
        </Match>
      </Switch>
    </ul>
  );
}
