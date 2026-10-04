import { Icon } from './icons';
import styles from './FailureNote.module.css';

/** A failed action's reason, shown where it was asked for, until dismissed. */
export function FailureNote(props: { text: string; onDismiss: () => void }) {
  return (
    <p class={`cp-error ${styles.note}`} role="alert">
      <span class={styles.text}>{props.text}</span>
      <button type="button" class={styles.dismiss} aria-label="Dismiss" onClick={() => props.onDismiss()}>
        <Icon name="close" />
      </button>
    </p>
  );
}
