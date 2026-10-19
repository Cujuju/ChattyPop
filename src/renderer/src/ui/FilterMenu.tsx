// A filter bar's "which of these to show" menu: a checklist popover under the caller's button, every item shown until some are unticked.
import { For, Show, createSignal, type JSX } from 'solid-js';
import { look } from '@/theme/look';
import { listen, onPointerDownOutside } from './listen';
import styles from './FilterMenu.module.css';

export interface FilterMenuItem<T> {
  id: T;
  label: string;
  /** A mark drawn in a tile before the label (a platform's icon); absent: no tile. */
  mark?: JSX.Element;
  /** The item's identity colour ([data-platform]); absent: the section's colour. */
  platform?: string;
  /** Beside the label, e.g. a count. */
  aside?: string;
  /** `section`: the aside in the section colour (something new); muted otherwise. */
  asideTone?: 'muted' | 'section';
}

export interface FilterMenuProps<T> {
  /** Names the checklist, e.g. "Sources to show". */
  label: string;
  /** Heads the checklist, e.g. "Sources". */
  heading: string;
  items: readonly FilterMenuItem<T>[];
  /** Every id an empty pick shows, listed or not. */
  all: readonly T[];
  /** The picked ids; empty shows every one. */
  picked: readonly T[];
  /** A new pick; empty when it would show every one. */
  onPick(next: T[]): void;
  /** The button: `menu.open` for its aria-expanded, `menu.toggle` for its click. */
  trigger(menu: { readonly open: boolean; toggle(): void }): JSX.Element;
  /** Sizes the root, which the menu hangs from (its end edge aligned). */
  class?: string;
}

export function FilterMenu<T>(props: FilterMenuProps<T>) {
  let root!: HTMLDivElement;
  const [open, setOpen] = createSignal(false);
  const shown = (id: T): boolean => !props.picked.length || props.picked.includes(id);
  /** Every id picked is no filter. */
  const pick = (next: T[]): void => props.onPick(next.length === props.all.length ? [] : next);
  const toggle = (id: T): void => pick(props.all.filter((x) => (x === id ? !shown(id) : shown(x))));
  /** The last listed item shown can't be hidden: the filter would show nothing. */
  const lastShown = (id: T): boolean => shown(id) && props.items.filter((i) => shown(i.id)).length === 1;

  onPointerDownOutside(() => root, open, () => setOpen(false));
  listen(window, 'keydown', (e) => {
    if (open() && e.key === 'Escape') setOpen(false);
  });

  return (
    <div class={`${styles.root} ${props.class ?? ''}`} ref={root}>
      {props.trigger({ get open() { return open(); }, toggle: () => setOpen(!open()) })}
      <Show when={open()}>
        <div class={`cp-popover ${styles.menu}`} role="group" aria-label={props.label}>
          <div class={`${styles.head} ${look.ruleBelow}`} data-rule="subtle">
            <span class={look.text} data-size="2xs" data-weight="semibold" data-case="upper" data-tracking="label" data-tone="muted">
              {props.heading}
            </span>
            <Show when={props.picked.length}>
              <button type="button" class={`${look.link} ${look.text}`} data-size="xs" onClick={() => props.onPick([])}>Show all</button>
            </Show>
          </div>
          <For each={props.items}>{(item) => (
            <div class={styles.row}>
              <label class={`${styles.option} ${look.identityOption} ${look.text}`} data-size="sm" data-platform={item.platform}
                title={lastShown(item.id) ? 'At least one shows' : undefined}>
                <input type="checkbox" checked={shown(item.id)} disabled={lastShown(item.id)} onChange={() => toggle(item.id)} />
                <Show when={item.mark}>
                  <span class={`${styles.tile} ${look.identityTile}`} aria-hidden="true">{item.mark}</span>
                </Show>
                <span class={styles.name}>{item.label}</span>
                <Show when={item.aside}>
                  <span class={`${styles.aside} ${look.text}`} data-size="xs" data-tone={item.asideTone ?? 'muted'} data-figures="tabular">{item.aside}</span>
                </Show>
              </label>
              <button type="button" class={`${styles.only} ${look.pillButton} ${look.text}`} data-size="2xs" aria-label={`Show only ${item.label}`}
                onClick={() => pick([item.id])}>Only</button>
            </div>
          )}</For>
        </div>
      </Show>
    </div>
  );
}
