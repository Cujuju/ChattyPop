import type { JSX } from 'solid-js';
import styles from './FailureNote.module.css';

/** Names the stopped view and offers one way on. */
export function ViewFailure(props: { name: string; button: string; onPress: () => void }): JSX.Element {
  return (
    <p class={`cp-error ${styles.note}`} role="alert">
      <span class={styles.text}>{props.name} stopped working.</span>
      <button type="button" class="cp-button" onClick={() => props.onPress()}>{props.button}</button>
    </p>
  );
}
