// Archive search field and its panel: the query builder, a filter's value picker, or results with operator feedback.
import { For, Match, Show, Switch, createEffect, createMemo, on } from 'solid-js';
import { SEARCH_MATCH_END, SEARCH_MATCH_START, type SearchHit } from '@shared/contract';
import { plainDiscordText } from '@shared/discordText';
import { channelById } from '@/state/directory';
import { searchTokens } from '@/plugins/slots';
import { parseSearchQuery } from '@shared/searchQuery';
import { openArchive } from '@/state/archive';
import { isSavedSearch, querySearch, savedSearches, searchFocusRequests, searchHits, searchOpen, searchText, setSearchOpen, toggleSavedSearch } from '@/state/search';
import { shortDateTime } from '@/ui/format';
import { createListNav } from '@/ui/listNav';
import { pendingFilter, searchFilters, withFilter, withValue } from './searchFilters';
import { AddFilterStrip, FilterList, ValuePicker } from './SearchBuilder';
import { Icon } from '@/ui/icons';
import styles from './Search.module.css';

/** A hit's text with its matches marked; Discord tokens as words (a token split by a match mark stays raw). Delimiters are control characters, so plain splitting is safe. */
function Snippet(props: { text: string; mentions: Record<string, string> }) {
  const text = () => plainDiscordText(props.text, { users: props.mentions, channel: (id) => channelById(id)?.name });
  const parts = () => text().split(SEARCH_MATCH_START).flatMap((chunk, i) => (i === 0 ? [{ text: chunk, hit: false }] : chunk.split(SEARCH_MATCH_END).map((t, j) => ({ text: t, hit: j === 0 }))));
  return <For each={parts()}>{(p) => (p.hit ? <mark class={styles.mark}>{p.text}</mark> : p.text)}</For>;
}

/**
 * F2 top-bar archive search: the leader, then "/", focuses it. Focus opens the panel: with the field empty it lists every
 * filter and the saved searches; a trailing `key:` offers that filter's values; otherwise results, which open the
 * message in the Archive.
 */
export function Search() {
  let input!: HTMLInputElement;
  const filters = createMemo(() => searchFilters(searchTokens()));
  const pending = () => pendingFilter(searchText(), filters());
  const mode = (): 'filters' | 'value' | 'results' => (searchText().trim() === '' ? 'filters' : pending() ? 'value' : 'results');
  const problems = () => parseSearchQuery(searchText(), searchTokens().map((t) => t.key)).problems;
  /** Replaces the query, keeping the field focused and the panel open. */
  const edit = (query: string): void => {
    querySearch(query);
    setActive(0);
    setSearchOpen(true);
    input.focus();
  };
  const open = (hit: SearchHit | undefined): void => {
    if (!hit) return;
    void openArchive(hit.channelId, hit.messageId);
    setSearchOpen(false);
    input.blur();
  };
  const rowCount = (): number => {
    if (mode() === 'filters') return filters().length + savedSearches().length;
    if (mode() === 'value') return pending()!.choices().length;
    return searchHits().length;
  };
  const { active, setActive, onKey } = createListNav(rowCount, {
    onEnter: (i) => {
      const f = pending();
      if (mode() === 'results') open(searchHits()[i]);
      else if (f) {
        const choice = f.choices()[i];
        if (choice) edit(withValue(searchText(), choice.value));
      } else if (i < filters().length) edit(withFilter(searchText(), filters()[i]!.key));
      else if (savedSearches()[i - filters().length]) edit(savedSearches()[i - filters().length]!);
    },
    onEscape: () => {
      setSearchOpen(false);
      input.blur();
    },
    activeEl: () => document.getElementById(`search-row-${active()}`),
  });
  const nav = { active, setActive };
  // The search shortcut (state/shortcuts.ts) asks for focus.
  createEffect(on(searchFocusRequests, () => input.focus(), { defer: true }));

  return (
    <div class={styles.root} onFocusOut={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setSearchOpen(false)}>
      <label for="archive-search" class="cp-visually-hidden">
        Search the archive
      </label>
      <div class={styles.field}>
        <Icon name="search" class={styles.icon} />
        <input
          ref={input}
          id="archive-search"
          class={`cp-stroke ${styles.input}`}
          type="search"
          placeholder="Search the archive"
          autocomplete="off"
          role="combobox"
          aria-expanded={searchOpen()}
          aria-controls="archive-search-results"
          aria-activedescendant={searchOpen() && rowCount() ? `search-row-${active()}` : undefined}
          value={searchText()}
          onInput={(e) => edit(e.currentTarget.value)}
          onFocus={() => setSearchOpen(true)}
          onKeyDown={onKey}
        />
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
                onSaved={edit}
                onRemoveSaved={toggleSavedSearch}
              />
            </Match>
            <Match when={pending()}>{(f) => <ValuePicker {...nav} filter={f()} onPick={(c) => edit(withValue(searchText(), c.value))} />}</Match>
            <Match when={mode() === 'results'}>
              <AddFilterStrip filters={filters()} onFilter={(f) => edit(withFilter(searchText(), f.key))} />
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
                <For each={searchHits()}>
                  {(hit, i) => (
                    // mousedown, not click: fires before the input's blur closes the list.
                    <li id={`search-row-${i()}`} role="option" aria-selected={active() === i()} onMouseEnter={() => setActive(i())} class={styles.hit} onMouseDown={(e) => (e.preventDefault(), open(hit))}>
                      <span class={styles.meta}>
                        #{hit.channelName} · {hit.authorName} · {shortDateTime(hit.ts)}
                      </span>
                      <span class={styles.snippet}>
                        <Snippet text={hit.snippet} mentions={hit.mentions} />
                      </span>
                    </li>
                  )}
                </For>
              </Show>
            </Match>
          </Switch>
        </ul>
      </Show>
    </div>
  );
}
