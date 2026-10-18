// The search field's finished filters as Discord-style chips: the key, a person's avatar or a place's server icon, the name and a remove button.
import { For, Show, createMemo, createResource } from 'solid-js';
import { Icon } from '@/ui/icons';
import type { FilterChoice, QueryChip } from './searchFilters';
import { Lead } from './SearchBuilder';
import styles from './SearchChips.module.css';

/** What a chip's term names: a choice now, one on its way (a person), or none. */
export type ChipChoice = FilterChoice | null | Promise<FilterChoice | null>;

function Chip(props: { chip: QueryChip; choice: (chip: QueryChip) => ChipChoice; onRemove: () => void }) {
  // Tracked: a place's choice follows the directory as it loads.
  const resolved = createMemo(() => props.choice(props.chip));
  const [arrived] = createResource(
    () => {
      const r = resolved();
      return r instanceof Promise ? r : undefined;
    },
    (p) => p,
  );
  const choice = (): FilterChoice | null => {
    const r = resolved();
    return r instanceof Promise ? (arrived.latest ?? null) : r;
  };
  return (
    <span class={styles.chip} data-problem={props.chip.problem || undefined} title={props.chip.raw}>
      <span class={styles.key}>
        {props.chip.negated ? '-' : ''}
        {props.chip.key}:
      </span>
      <Show when={choice()?.lead}>{(lead) => <Lead lead={lead()} class={styles.lead} />}</Show>
      <span class={styles.label}>
        <Show when={choice()?.sigil}>
          <span class={styles.sigil}>{choice()?.sigil}</span>
        </Show>
        {choice()?.label ?? props.chip.value}
      </span>
      {/* mousedown, not click: keeps focus (and the panel) in the field. */}
      <button type="button" class={styles.remove} tabIndex={-1} aria-label={`Remove ${props.chip.raw}`} onMouseDown={(e) => (e.preventDefault(), props.onRemove())}>
        <Icon name="close" />
      </button>
    </span>
  );
}

/** One chip per finished filter, in query order. */
export function SearchChips(props: { id: string; chips: readonly QueryChip[]; choice: (chip: QueryChip) => ChipChoice; onRemove: (chip: QueryChip) => void }) {
  return (
    <Show when={props.chips.length}>
      <span id={props.id} class={styles.chips}>
        <For each={props.chips}>{(chip) => <Chip chip={chip} choice={props.choice} onRemove={() => props.onRemove(chip)} />}</For>
      </span>
    </Show>
  );
}
