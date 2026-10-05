import { onMount, type JSX } from 'solid-js';
import { directory } from '@/state/directory';
import styles from './Picker.module.css';

/** A search as typed, for matching: lower case, without the colons of a `:name:`. */
export const normalQuery = (q: string): string => q.trim().replace(/:/g, '').toLowerCase();

/** Server ids for picker sections: this channel's server first, then the rest in sidebar order. */
export const guildOrder = (guildId: string): string[] => [guildId, ...directory().map((g) => g.id).filter((id) => id !== guildId)];

/** The picker tab's search field; focused on open, as in Discord. */
export function PickerSearch(props: { label: string; value: string; onInput: (v: string) => void }) {
  let input!: HTMLInputElement;
  onMount(() => input.focus());
  return (
    <input
      ref={input}
      class={`cp-stroke ${styles.search}`}
      type="search"
      aria-label={props.label}
      placeholder={props.label}
      value={props.value}
      onInput={(e) => props.onInput(e.currentTarget.value)}
    />
  );
}

/** A titled section of a picker's list. `bar`: the section bar's mark it belongs to (EmojiList), if the picker has one. */
export function PickerSection(props: { title: string; bar?: string; children: JSX.Element }) {
  return (
    <section class={styles.section} data-bar={props.bar}>
      <h3 class={styles.sectionTitle}>{props.title}</h3>
      {props.children}
    </section>
  );
}
