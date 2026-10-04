import { For, Show, createMemo, createSignal } from 'solid-js';
import { onPointerDownOutside } from './listen';
import { createListNav } from './listNav';
import type { SelectOption } from './Select';
import styles from './SearchSelect.module.css';

/** Rendered matches; typing narrows long lists (OpenRouter has hundreds of models) well below this. */
const MAX_SHOWN = 200;

/**
 * A select for long lists: shows the chosen label; opening it gives a search field that filters by label or value
 * (every typed word must match), with arrow keys, Enter and Escape.
 */
export function SearchSelect(props: {
  id?: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  class?: string;
  placeholder?: string;
}) {
  let root!: HTMLDivElement;
  let search!: HTMLInputElement;
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal('');
  const listId = () => `${props.id ?? 'search-select'}-list`;
  const label = () => props.options.find((o) => o.value === props.value)?.label ?? props.value;

  const matches = createMemo(() => {
    const words = query().toLowerCase().split(/\s+/).filter(Boolean);
    const hits = props.options.filter((o) => words.every((w) => `${o.label} ${o.value}`.toLowerCase().includes(w)));
    return hits.slice(0, MAX_SHOWN);
  });

  const selectedEl = (): Element | null => root.querySelector('[aria-selected="true"]');
  const { active, setActive, onKey } = createListNav(() => matches().length, {
    onEnter: (i) => choose(matches()[i]),
    onEscape: () => setOpen(false),
    activeEl: selectedEl,
    stopPropagation: true,
  });

  const show = (): void => {
    if (props.disabled) return;
    setQuery('');
    setActive(Math.max(0, props.options.findIndex((o) => o.value === props.value)));
    setOpen(true);
    queueMicrotask(() => {
      search.focus();
      selectedEl()?.scrollIntoView({ block: 'nearest' });
    });
  };
  function choose(o: SelectOption | undefined): void {
    if (o) props.onChange(o.value);
    setOpen(false);
  }

  // Clicking anywhere else closes the list.
  onPointerDownOutside(() => root, open, () => setOpen(false));

  return (
    <div class={`${styles.root} ${props.class ?? ''}`} ref={root}>
      <button
        type="button"
        id={props.id}
        class={styles.trigger}
        disabled={props.disabled}
        aria-haspopup="listbox"
        aria-expanded={open()}
        onClick={() => (open() ? setOpen(false) : show())}
      >
        <span class={styles.value}>{label() || props.placeholder}</span>
        <span class="cp-chevron" aria-hidden="true" />
      </button>
      <Show when={open()}>
        <div class={`cp-popover ${styles.popover}`}>
          <input
            ref={search}
            class={styles.search}
            type="search"
            placeholder="Type to filter…"
            autocomplete="off"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId()}
            aria-activedescendant={matches().length ? `${listId()}-${active()}` : undefined}
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setActive(0);
            }}
            onKeyDown={onKey}
          />
          <ul id={listId()} class={styles.list} role="listbox">
            <Show when={matches().length} fallback={<li class={styles.empty}>No matches</li>}>
              <For each={matches()}>
                {(o, i) => (
                  <li
                    id={`${listId()}-${i()}`}
                    class={styles.option}
                    role="option"
                    aria-selected={active() === i()}
                    data-current={o.value === props.value}
                    onMouseEnter={() => setActive(i())}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      choose(o);
                    }}
                  >
                    {o.label}
                  </li>
                )}
              </For>
            </Show>
          </ul>
        </div>
      </Show>
    </div>
  );
}
