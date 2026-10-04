import { createSignal, type Accessor, type Setter } from 'solid-js';

export interface ListNavOptions {
  /** Enter: the active row's index (it may be past the end when the list is empty). */
  onEnter: (i: number) => void;
  onEscape: () => void;
  /** The active row's element, scrolled into view after each handled key. */
  activeEl: () => Element | null | undefined;
  /** Keep handled keys from reaching outer handlers (Escape must not also close a surrounding dialog). */
  stopPropagation?: boolean;
}

export interface ListNav {
  active: Accessor<number>;
  setActive: Setter<number>;
  onKey: (e: KeyboardEvent) => void;
}

/** Keyboard selection in a listbox driven from a text field: arrows wrap, Enter picks, Escape closes. */
export function createListNav(count: () => number, opts: ListNavOptions): ListNav {
  const [active, setActive] = createSignal(0);
  const onKey = (e: KeyboardEvent): void => {
    const n = count();
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n) setActive((active() + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
    else if (e.key === 'Enter') opts.onEnter(active());
    else if (e.key === 'Escape') opts.onEscape();
    else return;
    e.preventDefault();
    if (opts.stopPropagation) e.stopPropagation();
    // After the update renders, so a newly drawn row can be scrolled to.
    queueMicrotask(() => opts.activeEl()?.scrollIntoView({ block: 'nearest' }));
  };
  return { active, setActive, onKey };
}
