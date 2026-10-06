import { For } from 'solid-js';
import { typingParts } from '@shared/typing';
import { typing } from '@/state/typing';
import styles from './TypingLine.module.css';

/** Typing line stays in layout when empty, preserving composer and log-end positions. */
export function TypingLine() {
  const parts = () => typingParts(typing());
  return (
    <p class={styles.typing} data-active={parts().length > 0} aria-live="polite">
      <span class={styles.text}>
        <For each={parts()}>{(p) => (p.kind === 'name' ? <span class={styles.name}>{p.text}</span> : p.text)}</For>
      </span>
    </p>
  );
}
