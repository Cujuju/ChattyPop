// The search panel's query builder: the filter list, a pending filter's value picker, and the add-filter strip.
// Rows are listbox options driven from the search field; `search-row-<i>` ids match its aria-activedescendant.
import { For, Show } from 'solid-js';
import { FILTER_GROUPS, type FilterChoice, type SearchFilter } from './searchFilters';
import { Icon } from '@/ui/icons';
import panel from './Search.module.css';
import styles from './SearchBuilder.module.css';

interface Nav {
  active: () => number;
  setActive: (i: number) => void;
}

/** Row props shared by every option: its id, selection and pick on mousedown (keeps focus, and the panel, in the field). */
const option = (nav: Nav, i: number, pick: () => void) => ({
  id: `search-row-${i}`,
  role: 'option' as const,
  get 'aria-selected'() {
    return nav.active() === i;
  },
  onMouseEnter: () => nav.setActive(i),
  onMouseDown: (e: MouseEvent) => (e.preventDefault(), pick()),
});

/** `key:` with its value placeholder, as typed in the field. */
function Token(props: { filter: SearchFilter; placeholder?: boolean }) {
  return (
    <span class={styles.token}>
      <span class={styles.tokenKey}>{props.filter.key}:</span>
      <Show when={props.placeholder}>
        <span class={styles.tokenValue}>{props.filter.value}</span>
      </Show>
    </span>
  );
}

/** Empty field: every filter by group, then saved searches (indexed after the filters), then the syntax tip. */
export function FilterList(props: Nav & { filters: readonly SearchFilter[]; saved: readonly string[]; onFilter: (f: SearchFilter) => void; onSaved: (q: string) => void; onRemoveSaved: (q: string) => void }) {
  const inGroup = (id: string) => props.filters.filter((f) => f.group === id);
  return (
    <>
      <For each={FILTER_GROUPS}>
        {(group) => (
          <Show when={inGroup(group.id).length}>
            <li class={panel.heading} role="presentation">
              {group.title}
            </li>
            <For each={inGroup(group.id)}>
              {(f) => (
                <li class={styles.filter} {...option(props, props.filters.indexOf(f), () => props.onFilter(f))}>
                  <Token filter={f} placeholder />
                  <span class={styles.filterDesc}>{f.description}</span>
                </li>
              )}
            </For>
          </Show>
        )}
      </For>
      <Show when={props.saved.length}>
        <li class={`${panel.heading} ${panel.divided}`} role="presentation">
          Saved searches
        </li>
        <For each={props.saved}>
          {(query, i) => (
            <li class={panel.saved} {...option(props, props.filters.length + i(), () => props.onSaved(query))}>
              <span class={panel.savedQuery}>{query}</span>
              <button
                type="button"
                class={panel.remove}
                tabIndex={-1}
                aria-label={`Remove saved search ${query}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  props.onRemoveSaved(query);
                }}
              >
                <Icon name="close" />
              </button>
            </li>
          )}
        </For>
      </Show>
      <li class={styles.tip} role="presentation">
        Start a filter with <code>-</code> to exclude it, as in <code>-has:link</code>. Quote values with spaces.
      </li>
    </>
  );
}

/** A typed `key:` awaiting its value: its choices as chips, or how to type a free-text value. */
export function ValuePicker(props: Nav & { filter: SearchFilter; onPick: (c: FilterChoice) => void }) {
  return (
    <>
      <li class={styles.valueHead} role="presentation">
        <Token filter={props.filter} />
        <span class={styles.filterDesc}>{props.filter.description}</span>
      </li>
      <Show
        when={props.filter.choices().length}
        fallback={
          <li class={styles.tip} role="presentation">
            Type a {props.filter.value} after <code>{props.filter.key}:</code> and quote it if it has spaces.
          </li>
        }
      >
        <li role="presentation">
          <ul class={styles.choices} role="group" aria-label={`${props.filter.key} values`}>
            <For each={props.filter.choices()}>
              {(c, i) => (
                <li class={styles.choice} {...option(props, i(), () => props.onPick(c))} title={c.label === c.value ? undefined : c.value}>
                  {c.label}
                </li>
              )}
            </For>
          </ul>
        </li>
      </Show>
    </>
  );
}

/** Above results: every filter's key as a chip that appends it to the query. Pointer only; typing covers the keyboard. */
export function AddFilterStrip(props: { filters: readonly SearchFilter[]; onFilter: (f: SearchFilter) => void }) {
  return (
    <li class={styles.strip} role="presentation">
      <span class={styles.stripLabel}>Add</span>
      <For each={props.filters}>
        {(f) => (
          <button type="button" class={styles.stripChip} tabIndex={-1} title={f.description} onMouseDown={(e) => (e.preventDefault(), props.onFilter(f))}>
            {f.key}:
          </button>
        )}
      </For>
    </li>
  );
}
