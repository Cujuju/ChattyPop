import { Show } from 'solid-js';
import { Icon } from './icons';
import styles from './ThreadFold.module.css';

/**
 * A channel row's fold slot, before its sigil: a chevron (turned down while its threads show) when it has threads, else
 * empty, so names line up. A click on it folds; the row's click handler routes it (foldGesture, FOLD_CHEVRON_ATTR).
 */
export function FoldChevron(props: { foldable: boolean; open: boolean }) {
  return (
    <span class={styles.chevron} data-fold-slot data-fold-chevron={props.foldable ? '' : undefined} data-open={props.open} aria-hidden="true">
      <Show when={props.foldable}>
        <Icon name="chevronRight" class={styles.chevronIcon} />
      </Show>
    </span>
  );
}

/** A folded channel's threads holding new messages: the thread mark and how many. `compact`: a rail tile's corner badge. */
export function ThreadsBadge(props: { count: number; compact?: boolean; class?: string }) {
  const label = () => `${props.count} new in threads`;
  return (
    <span class={props.class ? `${styles.badge} ${props.class}` : styles.badge} data-size={props.compact ? 'compact' : undefined} role="img" aria-label={label()} title={label()}>
      <Icon name="thread" class={styles.badgeIcon} />
      {props.count}
    </span>
  );
}

/** A thread row's hooked line, dropping from its parent channel's sigil into the thread's name (Discord's thread idiom). */
export function ThreadSpine() {
  return <span class={styles.spine} aria-hidden="true" />;
}
