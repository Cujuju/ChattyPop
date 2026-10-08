import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onMount, type JSX } from 'solid-js';
import { Icon } from './icons';
import { createListNav } from './listNav';
import type { SearchOption } from './SearchSelect';
import styles from './SearchSelect.module.css';

/** Bounds rendered rows for model catalogs; filtering narrows the catalog before this cap. */
const MAX_SHOWN = 200;

interface Group {
  head: SearchOption;
  kids: SearchOption[];
}

/** A listed row: a choice; a group's hidden tail, opened by picking it; or a rule between groups. */
type Row = { kind: 'option'; o: SearchOption } | { kind: 'more'; head: SearchOption; count: number } | { kind: 'rule' };
type PickRow = Exclude<Row, { kind: 'rule' }>;

export function groupsOf(options: readonly SearchOption[]): Group[] {
  const groups: Group[] = [];
  for (const o of options) {
    const last = groups.at(-1);
    if (o.nested && last) last.kids.push(o);
    else groups.push({ head: o, kids: [] });
  }
  return groups;
}

export interface SearchListHandle {
  focusSearch: () => void;
  scrollCurrent: () => void;
  onKey: (e: KeyboardEvent) => void;
}

/** Shared filter, grouping, selection and keyboard navigation for either picker surface. */
export function SearchList(props: {
  id: string;
  value: string;
  options: SearchOption[];
  label: string;
  searchLabel: string;
  onReady: (handle: SearchListHandle) => void;
  onLayout: () => void;
  onClose: () => void;
  onPick: (value: string) => void;
}) {
  let root!: HTMLDivElement;
  let search!: HTMLInputElement;
  const [query, setQuery] = createSignal('');
  const [opened, setOpened] = createSignal<ReadonlySet<string>>(new Set());
  const groups = createMemo(() => groupsOf(props.options));
  const tree = () => props.options.some((o) => o.nested);
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

  const activeEl = (): Element | null => root.querySelector('[data-active="true"]');
  const { active, setActive, onKey } = createListNav(() => picks().length, {
    onEnter: (i) => pick(picks()[i]),
    onEscape: props.onClose,
    activeEl,
    stopPropagation: true,
  });

  onMount(() => {
    setActive(Math.max(0, picks().findIndex((r) => r.kind === 'option' && r.o.value === props.value)));
    props.onReady({
      focusSearch: () => search.focus({ preventScroll: true }),
      scrollCurrent: () => root.querySelector('[data-current="true"]')?.scrollIntoView({ block: 'nearest' }),
      onKey,
    });
  });
  createEffect(() => { rows(); queueMicrotask(props.onLayout); });
  function pick(r: PickRow | undefined): void {
    if (r?.kind === 'more') {
      setOpened((s) => new Set(s).add(r.head.value));
      return;
    }
    if (r) props.onPick(r.o.value);
  }
  const lead = (o: SearchOption | undefined): JSX.Element => (
    <Show when={o?.lead}>{(draw) => <span class={styles.lead} aria-hidden="true">{draw()()}</span>}</Show>
  );
  return (
    <div ref={root} class={styles.content} onKeyDown={onKey}>
      <input
        ref={search}
        class={styles.search}
        type="search"
        placeholder="Type to filter…"
        aria-label={props.searchLabel}
        autocomplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded="true"
        aria-controls={props.id}
        aria-activedescendant={picks().length ? `${props.id}-${active()}` : undefined}
        value={query()}
        onInput={(e) => {
          setQuery(e.currentTarget.value);
          setActive(0);
        }}
      />
      <ul id={props.id} class={styles.list} role="listbox" aria-label={props.label} data-tree={tree()}>
        <Show when={rows().length} fallback={<li class={styles.empty}>No matches</li>}>
          <For each={rows()}>
            {(r) => {
              const i = () => picks().indexOf(r as PickRow);
              const hover = (): void => void setActive(i());
              // Select on click, so touch scrolling and assistive activation share one path.
              const press = (e: MouseEvent): void => {
                if (e.button === 0) e.preventDefault();
              };
              return (
                <Switch>
                  <Match when={r.kind === 'rule'}>
                    <li class={styles.rule} role="separator" />
                  </Match>
                  <Match when={r.kind === 'more' && r}>
                    {(m) => (
                      <li
                        id={`${props.id}-${i()}`}
                        class={`${styles.option} ${styles.more}`}
                        role="option"
                        aria-selected="false"
                        data-active={active() === i()}
                        data-nested="true"
                        onMouseEnter={hover}
                        onMouseDown={press}
                        onClick={() => pick(r as PickRow)}
                      >
                        <span class={styles.lead} />
                        <span class={styles.label}>{`Show all ${m().count}`}</span>
                      </li>
                    )}
                  </Match>
                  <Match when={r.kind === 'option' && r.o}>
                    {(o) => (
                      <li
                        id={`${props.id}-${i()}`}
                        class={styles.option}
                        role="option"
                        aria-selected={o().value === props.value}
                        data-active={active() === i()}
                        data-current={o().value === props.value}
                        data-nested={!!o().nested}
                        onMouseEnter={hover}
                        onMouseDown={press}
                        onClick={() => pick(r as PickRow)}
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
  );
}
