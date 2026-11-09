// The archive search field: magnifier, finished filters as chips, the draft, and the save star.
import { Show } from 'solid-js';
import { isSavedSearch, searchText, setSearchOpen, toggleSavedSearch } from '@/state/search';
import { Icon } from '@/ui/icons';
import { SearchChips } from './SearchChips';
import type { SearchController } from './searchController';
import styles from './Search.module.css';

export function SearchField(props: { search: SearchController }) {
  const s = props.search;
  let input!: HTMLInputElement;
  const dropdown = s.surface === 'dropdown';
  return (
    <>
      <label for="archive-search" class="cp-visually-hidden">
        Search the archive
      </label>
      {/* A press on the field's ground or a chip types into the draft; buttons keep their own presses. */}
      <div class={`cp-stroke ${styles.field}`} onMouseDown={(e) => e.target !== input && !(e.target as Element).closest('button') && (e.preventDefault(), input.focus())}>
        {/* Dropdown: the magnifier toggles search on mousedown, before blur, keeping field focus. Panel: it only focuses the field. */}
        <button
          type="button"
          class={styles.icon}
          tabIndex={-1}
          aria-label={dropdown && s.showing() ? 'Close search' : 'Search the archive'}
          onMouseDown={(e) => {
            e.preventDefault();
            if (dropdown && s.showing()) s.close();
            else input.focus();
          }}
        >
          <Icon name="search" />
        </button>
        <div ref={s.setQuery} class={styles.query}>
          <SearchChips id="archive-search-filters" chips={s.chips()} choice={s.choiceFor} onRemove={s.removeChip} />
          <input
            ref={(el) => (input = el, s.setInput(el))}
            id="archive-search"
            class={styles.input}
            type="search"
            placeholder={s.chips().length ? undefined : 'Search the archive'}
            autocomplete="off"
            role="combobox"
            aria-expanded={s.showing()}
            aria-controls="archive-search-results"
            aria-activedescendant={s.showing() && s.rowCount() ? `search-row-${s.active()}` : undefined}
            aria-describedby={s.chips().length ? 'archive-search-filters' : undefined}
            value={s.draft()}
            onInput={(e) => s.onDraft(e.currentTarget)}
            onFocus={() => dropdown && setSearchOpen(true)}
            onKeyDown={(e) => (s.onBackspace(e), s.onKey(e))}
          />
        </div>
        <Show when={s.mode() !== 'filters'}>
          <button
            type="button"
            class={styles.save}
            aria-pressed={isSavedSearch(searchText())}
            title={isSavedSearch(searchText()) ? 'Remove from saved searches' : 'Save this search'}
            // mousedown, not click: keeps focus (and the list) in the field.
            onMouseDown={(e) => {
              e.preventDefault();
              toggleSavedSearch(searchText());
            }}
          >
            <Icon name="star" />
          </button>
        </Show>
      </div>
    </>
  );
}
