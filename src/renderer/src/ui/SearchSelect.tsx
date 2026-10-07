import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, type JSX } from 'solid-js';
import { Icon } from './icons';
import { keepOnScreen } from './keepOnScreen';
import { listen, onPointerDownOutside } from './listen';
import { createListNav } from './listNav';
import type { SelectOption } from './Select';
import styles from './SearchSelect.module.css';

/** Rendered rows; typing narrows long lists (OpenRouter has hundreds of models) well below this. */
const MAX_SHOWN = 200;
/** The theme's gap between the trigger and its list (sizes.css), read where the list is placed. */
const GAP_TOKEN = '--cp-popover-gap';

/** A choice; options may form a tree one level deep: a top-level option and the nested ones after it. */
export interface SearchOption extends SelectOption {
  /** Listed under the nearest top-level option above it (its parent). Filtering by the parent's label finds it; a match shows its parent. */
  nested?: boolean;
  /** A long tail its parent stands for (each DM): listed while filtering, or once its group's "more" row is opened. */
  searchOnly?: boolean;
  /** Drawn before the label, in the list and on the trigger: a server's icon, a channel's glyph. */
  lead?: () => JSX.Element;
}

interface Group {
  head: SearchOption;
  kids: SearchOption[];
}

/** A listed row: a choice; a group's hidden tail, opened by picking it; or a rule between groups. */
type Row = { kind: 'option'; o: SearchOption } | { kind: 'more'; head: SearchOption; count: number } | { kind: 'rule' };
type PickRow = Exclude<Row, { kind: 'rule' }>;

function groupsOf(options: readonly SearchOption[]): Group[] {
  const groups: Group[] = [];
  for (const o of options) {
    const last = groups.at(-1);
    if (o.nested && last) last.kids.push(o);
    else groups.push({ head: o, kids: [] });
  }
  return groups;
}

/**
 * Searchable long-list select: every query word must match an option's label or value (a nested one's parent label too).
 * Arrows, Enter and Escape work from the filter field. The list floats in the top layer, sized to its labels and kept on screen.
 */
export function SearchSelect(props: {
  id?: string;
  value: string;
  options: SearchOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  /** On the root: its width and height size the trigger. */
  class?: string;
  placeholder?: string;
}) {
  let root!: HTMLDivElement;
  let trigger!: HTMLButtonElement;
  let pop: HTMLDivElement | undefined;
  let search!: HTMLInputElement;
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal('');
  /** Top-level values whose search-only tail is listed without filtering. */
  const [opened, setOpened] = createSignal<ReadonlySet<string>>(new Set());
  const listId = () => `${props.id ?? 'search-select'}-list`;
  // Read once per change: a caller's getter may build fresh options on every read.
  const options = createMemo(() => props.options);
  const groups = createMemo(() => groupsOf(options()));
  const tree = () => options().some((o) => o.nested);
  const current = () => options().find((o) => o.value === props.value);
  /** The trigger's tooltip for a nested choice: its parent, then it. */
  const path = (): string | undefined => {
    const o = current();
    const parent = o?.nested ? groups().find((g) => g.kids.includes(o))?.head : undefined;
    return parent && `${parent.label} › ${o!.label}`;
  };

  // One row object per option, and per group for its rule, so filtering keeps their elements.
  const optionRows = new WeakMap<SearchOption, Row>();
  const ruleRows = new WeakMap<SearchOption, Row>();
  const rowOf = (o: SearchOption, cache: WeakMap<SearchOption, Row>, make: () => Row): Row => {
    if (!cache.has(o)) cache.set(o, make());
    return cache.get(o)!;
  };

  const rows = createMemo((): Row[] => {
    const words = query().toLowerCase().split(/\s+/).filter(Boolean);
    const hits = (...texts: string[]): boolean => words.every((w) => texts.join(' ').toLowerCase().includes(w));
    const out: Row[] = [];
    let aboveHasRows = false;
    for (const { head, kids } of groups()) {
      const headHit = hits(head.label, head.value);
      // The current choice stays listed, even from a hidden tail.
      const shown = words.length
        ? kids.filter((k) => hits(head.label, k.label, k.value))
        : kids.filter((k) => !k.searchOnly || k.value === props.value || opened().has(head.value));
      if (!headHit && !shown.length) continue;
      const hidden = words.length ? 0 : kids.length - shown.length;
      const hasRows = shown.length > 0 || hidden > 0;
      // A rule sets a group with rows under it apart from its neighbours.
      if (out.length && (hasRows || aboveHasRows)) out.push(rowOf(head, ruleRows, () => ({ kind: 'rule' })));
      aboveHasRows = hasRows;
      out.push(...[head, ...shown].map((o) => rowOf(o, optionRows, () => ({ kind: 'option', o }))));
      if (hidden) out.push({ kind: 'more', head, count: hidden });
      if (out.length >= MAX_SHOWN) break;
    }
    return out.slice(0, MAX_SHOWN);
  });
  /** The rows arrows move through, in order. */
  const picks = createMemo(() => rows().filter((r): r is PickRow => r.kind !== 'rule'));

  const selectedEl = (): Element | null => root.querySelector('[aria-selected="true"]');
  const { active, setActive, onKey } = createListNav(() => picks().length, {
    onEnter: (i) => pick(picks()[i]),
    onEscape: () => setOpen(false),
    activeEl: selectedEl,
    stopPropagation: true,
  });

  /**
   * Below the trigger, as wide as its labels need and never narrower than the trigger; above it when there's no room below.
   * Filtering only widens it, so the list doesn't jump narrower under the pointer.
   */
  const place = (): void => {
    if (!pop?.isConnected) return;
    const r = trigger.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(pop).getPropertyValue(GAP_TOKEN)) || 0;
    pop.style.minWidth = `${Math.max(r.width, pop.getBoundingClientRect().width)}px`;
    keepOnScreen(pop, r.left, r.bottom + gap, { x: r.right, y: r.top - gap });
  };

  const show = (): void => {
    if (props.disabled) return;
    setQuery('');
    setOpened(new Set<string>());
    setOpen(true);
    setActive(Math.max(0, picks().findIndex((r) => r.kind === 'option' && r.o.value === props.value)));
    queueMicrotask(() => {
      pop?.showPopover();
      place();
      search.focus();
      selectedEl()?.scrollIntoView({ block: 'nearest' });
    });
  };
  function pick(r: PickRow | undefined): void {
    if (r?.kind === 'more') {
      const at = active();
      setOpened((s) => new Set(s).add(r.head.value));
      setActive(at);
      search.focus();
      return;
    }
    if (r) props.onChange(r.o.value);
    setOpen(false);
  }

  // Clicking anywhere else closes the list; new rows (filtering, a tail opened), the page scrolling or resizing place it again.
  onPointerDownOutside(() => root, open, () => setOpen(false));
  createEffect(on(rows, () => queueMicrotask(place), { defer: true }));
  listen(window, 'resize', () => open() && place());
  listen(window, 'scroll', (e) => open() && !pop?.contains(e.target as Node) && place(), { capture: true, passive: true });

  const lead = (o: SearchOption | undefined): JSX.Element => (
    <Show when={o?.lead}>{(draw) => <span class={styles.lead}>{draw()()}</span>}</Show>
  );

  return (
    <div class={`${styles.root} ${props.class ?? ''}`} ref={root}>
      <button
        ref={trigger}
        type="button"
        id={props.id}
        class={styles.trigger}
        disabled={props.disabled}
        title={path()}
        aria-haspopup="listbox"
        aria-expanded={open()}
        onClick={() => (open() ? setOpen(false) : show())}
      >
        {lead(current())}
        <span class={styles.value}>{current()?.label ?? (props.value || props.placeholder)}</span>
        <span class="cp-chevron" aria-hidden="true" />
      </button>
      <Show when={open()}>
        <div ref={pop} popover="manual" class={`cp-popover ${styles.popover}`}>
          <input
            ref={search}
            class={styles.search}
            type="search"
            placeholder="Type to filter…"
            autocomplete="off"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId()}
            aria-activedescendant={picks().length ? `${listId()}-${active()}` : undefined}
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setActive(0);
            }}
            onKeyDown={onKey}
          />
          <ul id={listId()} class={styles.list} role="listbox" data-tree={tree()}>
            <Show when={rows().length} fallback={<li class={styles.empty}>No matches</li>}>
              <For each={rows()}>
                {(r) => {
                  const i = () => picks().indexOf(r as PickRow);
                  const hover = (): void => void setActive(i());
                  const press = (e: MouseEvent): void => {
                    e.preventDefault();
                    pick(r as PickRow);
                  };
                  return (
                    <Switch>
                      <Match when={r.kind === 'rule'}>
                        <li class={styles.rule} role="separator" />
                      </Match>
                      <Match when={r.kind === 'more' && r}>
                        {(m) => (
                          <li
                            id={`${listId()}-${i()}`}
                            class={`${styles.option} ${styles.more}`}
                            role="option"
                            aria-selected={active() === i()}
                            data-nested="true"
                            onMouseEnter={hover}
                            onMouseDown={press}
                          >
                            <span class={styles.lead} />
                            <span class={styles.label}>{`Show all ${m().count}`}</span>
                          </li>
                        )}
                      </Match>
                      <Match when={r.kind === 'option' && r.o}>
                        {(o) => (
                          <li
                            id={`${listId()}-${i()}`}
                            class={styles.option}
                            role="option"
                            aria-selected={active() === i()}
                            data-current={o().value === props.value}
                            data-nested={!!o().nested}
                            onMouseEnter={hover}
                            onMouseDown={press}
                          >
                            {lead(o())}
                            <span class={styles.label}>{o().label}</span>
                            <Show when={o().value === props.value}>
                              <Icon name="check" class={styles.check} />
                            </Show>
                          </li>
                        )}
                      </Match>
                    </Switch>
                  );
                }}
              </For>
            </Show>
          </ul>
        </div>
      </Show>
    </div>
  );
}
