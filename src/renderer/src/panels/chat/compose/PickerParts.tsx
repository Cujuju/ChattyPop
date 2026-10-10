import { For, createSignal, onMount, type JSX } from 'solid-js';
import { directory } from '@/state/directory';
import { inCompanion } from '@/state/ui';
import { CELLS_PER_PIECE, gridRows, type GridStaging } from './gridStaging';
import styles from './Picker.module.css';
import { Icon, type IconName } from '@/ui/icons';

/** A search as typed, for matching: lower case, without the colons of a `:name:`. */
export const normalQuery = (q: string): string => q.trim().replace(/:/g, '').toLowerCase();

/** Server ids for picker sections: this channel's server first, then the rest in sidebar order. */
export const guildOrder = (guildId: string): string[] => [guildId, ...directory().map((g) => g.id).filter((id) => id !== guildId)];

/** The picker tab's search field; focused on open, as in Discord. Not on the phone, where focus raises the keyboard over the picker. */
export function PickerSearch(props: { label: string; value: string; onInput: (v: string) => void }) {
  let input!: HTMLInputElement;
  onMount(() => {
    if (!inCompanion) input.focus();
  });
  return (
    <label class={`cp-stroke ${styles.search}`}>
      <Icon name="search" />
      <input
        ref={input}
        class={styles.searchInput}
        type="search"
        aria-label={props.label}
        placeholder={props.label}
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
      />
    </label>
  );
}

/** A titled section of a picker's list. `bar`: the section bar's mark it belongs to (EmojiList), if the picker has one. */
export function PickerSection(props: { title: string; bar?: string; icon?: IconName; children: JSX.Element }) {
  return (
    <section class={styles.section} data-bar={props.bar}>
      <h3 class={styles.sectionTitle}>{props.icon && <Icon name={props.icon} />}{props.title}</h3>
      {props.children}
    </section>
  );
}

/**
 * An emoji grid whose cells are built in pieces, as `staging` calls for them: when its list's view nears them. Until
 * whole it holds its rows' height, so the sections after it keep their places for a section bar's jumps.
 */
export function StagedGrid<T>(props: { staging: GridStaging; items: readonly T[] | undefined; children: (item: T) => JSX.Element }) {
  let grid!: HTMLDivElement;
  /** Cells built so far; Infinity once whole, so items that come later (a search cleared) show too. */
  const [shown, setShown] = createSignal(0);
  const built = (): boolean => shown() === Infinity;
  onMount(() =>
    props.staging.watch(grid, () => {
      setShown((n) => (n + CELLS_PER_PIECE >= (props.items?.length ?? 0) ? Infinity : n + CELLS_PER_PIECE));
      return built();
    }),
  );
  return (
    <div ref={grid} class={styles.emojiGrid} data-held={!built()} style={{ '--held-rows': built() ? undefined : gridRows(props.items?.length ?? 0, props.staging.columns()) }}>
      <For each={built() ? props.items : props.items?.slice(0, shown())}>{props.children}</For>
    </div>
  );
}
