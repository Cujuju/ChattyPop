import { For, Show, createResource, createSignal, createUniqueId, type JSX } from 'solid-js';
import { listen, onPointerDownOutside } from '@/ui/listen';
import { createListNav } from '@/ui/listNav';
import { RemovableChip } from './TermChips';
import styles from './Rules.module.css';

export interface PickOption {
  value: string;
  label: string;
  /** A second, quieter line (a server's name, a username). */
  hint?: string;
}

/** Options shown before typing narrows them; a long channel list is searched, not scrolled. */
const MAX_SHOWN = 50;
/** Gap kept between a popover and the window's edges, as the context menu keeps. */
const EDGE_MARGIN_PX = 8;

/** Positions popovers near anchors within window bounds, flipping above if needed. Outside scroll/resize closes detached popovers. */
function floatUnder(anchor: HTMLElement, pop: HTMLElement, close: () => void): void {
  listen(
    window,
    'scroll',
    (e) => {
      if (!pop.contains(e.target as Node)) close();
    },
    true,
  );
  listen(window, 'resize', close);
  // Measure once rendered.
  queueMicrotask(() => {
    const a = anchor.getBoundingClientRect();
    const p = pop.getBoundingClientRect();
    const below = a.bottom + EDGE_MARGIN_PX;
    const top = below + p.height <= innerHeight - EDGE_MARGIN_PX ? below : Math.max(EDGE_MARGIN_PX, a.top - EDGE_MARGIN_PX - p.height);
    pop.style.left = `${Math.max(EDGE_MARGIN_PX, Math.min(a.left, innerWidth - p.width - EDGE_MARGIN_PX))}px`;
    pop.style.top = `${top}px`;
  });
}

/** Add chips open searchable lists. options matches every word locally; search queries core after typing. */
export function AddPicker(props: {
  label: string;
  onPick: (value: string) => void;
  options?: () => PickOption[];
  search?: (query: string) => Promise<PickOption[]>;
  placeholder?: string;
  empty?: string;
}) {
  let root!: HTMLDivElement;
  let input!: HTMLInputElement;
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal('');
  const listId = createUniqueId();
  const [found] = createResource(
    () => (props.search && open() && query().trim() ? query() : null),
    (q) => props.search!(q),
    { initialValue: [] },
  );
  const shown = (): PickOption[] => {
    if (props.search) return found();
    const words = query().toLowerCase().split(/\s+/).filter(Boolean);
    return (props.options?.() ?? []).filter((o) => words.every((w) => `${o.label} ${o.hint ?? ''}`.toLowerCase().includes(w))).slice(0, MAX_SHOWN);
  };
  const emptyText = (): string => {
    if (props.search && !query().trim()) return 'Type a name';
    return found.loading ? 'Searching…' : (props.empty ?? 'Nothing matches');
  };
  const pick = (o: PickOption): void => {
    props.onPick(o.value);
    setOpen(false);
  };
  const { active, setActive, onKey } = createListNav(() => shown().length, {
    onEnter: (i) => {
      const o = shown()[i];
      if (o) pick(o);
    },
    onEscape: () => setOpen(false),
    activeEl: () => document.getElementById(`${listId}-${active()}`),
    stopPropagation: true, // Escape closes only the picker
  });
  const show = (): void => {
    setQuery('');
    setActive(0);
    setOpen(true);
    queueMicrotask(() => input.focus());
  };

  onPointerDownOutside(() => root, open, () => setOpen(false));

  return (
    <div class={styles.pickerAnchor} ref={root}>
      <button type="button" class={styles.addChip} aria-haspopup="listbox" aria-expanded={open()} onClick={() => (open() ? setOpen(false) : show())}>
        + {props.label}
      </button>
      <Show when={open()}>
        <div class={`cp-popover ${styles.pickerPopover}`} ref={(el) => floatUnder(root, el, () => setOpen(false))}>
          <input
            ref={input}
            class={styles.pickerSearch}
            type="search"
            placeholder={props.placeholder ?? 'Search'}
            autocomplete="off"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={shown().length ? `${listId}-${active()}` : undefined}
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setActive(0);
            }}
            onKeyDown={onKey}
          />
          <ul id={listId} class={styles.pickerList} role="listbox" aria-label={props.label}>
            <For each={shown()} fallback={<li class={styles.pickerEmpty}>{emptyText()}</li>}>
              {(o, i) => (
                <li
                  id={`${listId}-${i()}`}
                  class={styles.pickerOption}
                  role="option"
                  aria-selected={active() === i()}
                  onMouseEnter={() => setActive(i())}
                  onMouseDown={(e) => {
                    e.preventDefault(); // keep the search focused
                    pick(o);
                  }}
                >
                  <span>{o.label}</span>
                  <Show when={o.hint}>
                    <span class={styles.pickerHint}>{o.hint}</span>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>
    </div>
  );
}

/** Chosen values as removable chips, then whatever adds more. */
export function ChipRow<T>(props: { items: readonly T[]; label: (item: T) => string; onRemove: (item: T) => void; children?: JSX.Element }) {
  return (
    <div class={styles.chips}>
      <For each={props.items}>{(it) => <RemovableChip label={props.label(it)} onRemove={() => props.onRemove(it)} />}</For>
      {props.children}
    </div>
  );
}

/** A free-text entry chip (a site): typed, checked by `accept` (null refuses it, with `refused` shown). */
export function AddTextChip(props: { label: string; placeholder: string; accept: (raw: string) => string | null; refused: string; onAdd: (value: string) => void }) {
  let root!: HTMLDivElement;
  let input!: HTMLInputElement;
  const [open, setOpen] = createSignal(false);
  const [text, setText] = createSignal('');
  const [bad, setBad] = createSignal(false);
  const add = (): void => {
    const v = props.accept(text());
    setBad(v === null);
    if (v === null) return;
    props.onAdd(v);
    setText('');
    setOpen(false);
  };
  onPointerDownOutside(() => root, open, () => setOpen(false));
  return (
    <div class={styles.pickerAnchor} ref={root}>
      <button
        type="button"
        class={styles.addChip}
        aria-expanded={open()}
        onClick={() => {
          if (open()) return setOpen(false);
          setText('');
          setBad(false);
          setOpen(true);
          queueMicrotask(() => input.focus());
        }}
      >
        + {props.label}
      </button>
      <Show when={open()}>
        <div class={`cp-popover ${styles.pickerPopover}`} ref={(el) => floatUnder(root, el, () => setOpen(false))}>
          <input
            ref={input}
            class={styles.pickerSearch}
            type="text"
            placeholder={props.placeholder}
            value={text()}
            aria-invalid={bad()}
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation(); // closes only this entry
                setOpen(false);
              }
              if (e.key !== 'Enter') return;
              e.preventDefault(); // not the form's submit
              add();
            }}
          />
          <Show when={bad()}>
            <p class="cp-note cp-note-error">{props.refused}</p>
          </Show>
        </div>
      </Show>
    </div>
  );
}
