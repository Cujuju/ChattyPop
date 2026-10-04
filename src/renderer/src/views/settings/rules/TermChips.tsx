import type { JSX } from 'solid-js';
import { Icon } from '@/ui/icons';
import styles from './TermChips.module.css';

/** A chip in a `.terms` row with a remove button: a keyword, a file, a chosen emoji. `children` go before the label. */
export function RemovableChip(props: {
  label: string;
  /** Names the chip in the remove button's label; defaults to `label`. */
  removeName?: string;
  onRemove: () => void;
  children?: JSX.Element;
}) {
  return (
    <span class={styles.term}>
      {props.children}
      {props.label}
      <button type="button" class={styles.termRemove} aria-label={`Remove ${props.removeName ?? props.label}`} onClick={() => props.onRemove()}>
        <Icon name="close" />
      </button>
    </span>
  );
}

/** A field-looking box of chips (and an entry after them) that wraps: a word list, files, a chosen emoji. */
export const ChipField = (props: { children: JSX.Element }) => <div class={styles.terms}>{props.children}</div>;
