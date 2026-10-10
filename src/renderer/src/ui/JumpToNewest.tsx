import { Icon } from './icons';
import styles from './LogParts.module.css';

/** "Jump to newest" overlay for a chronological log scrolled up from its newest row: an arrow alone, named by `label`. */
export function JumpToNewest(props: { label: string; onClick: () => void }) {
  return (
    // Overlay pinned to the bottom of the scroll area; placement is structural, look is in LogParts.module.css. A log
    // with a box under it sets the inset that clears the box, and the gap and end that sit the button on it.
    <button
      type="button"
      class={styles.jumpToBottom}
      aria-label={props.label}
      title={props.label}
      onClick={() => props.onClick()}
      style={{ position: 'absolute', 'z-index': 'var(--cp-z-log-overlay)', bottom: 'calc(var(--cp-log-overlay-inset, 0px) + var(--cp-log-overlay-gap, var(--cp-space-7)))', right: 'var(--cp-log-overlay-end, var(--cp-space-7))' }}
    >
      <Icon name="arrowDown" class={styles.jumpIcon} />
    </button>
  );
}
