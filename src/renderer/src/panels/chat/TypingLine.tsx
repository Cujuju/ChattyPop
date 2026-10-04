import { For } from 'solid-js';
import { typingParts } from '@shared/typing';
import { typing } from '@/state/typing';
import styles from './TypingLine.module.css';

/** Who is typing in the open channel, Discord's line above the message box. Always in the layout, empty while no one is:
 * the box and the log's end never move as it comes and goes. */
export function TypingLine() {
  const parts = () => typingParts(typing());
  return (
    <p class={styles.typing} aria-live="polite">
      <For each={parts()}>{(p) => (p.kind === 'name' ? <span class={styles.name}>{p.text}</span> : p.text)}</For>
    </p>
  );
}
