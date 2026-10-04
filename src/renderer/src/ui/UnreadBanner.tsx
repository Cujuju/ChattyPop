import { today } from '@/state/clock';
import { clockTime, shortDateTime } from './dates';
import { Icon } from './icons';
import styles from './LogParts.module.css';

/** "3 new messages since 14:05"; with the date before today. */
const label = (count: number, sinceTs: number): string =>
  `${count} new message${count === 1 ? '' : 's'} since ${sinceTs >= today() ? clockTime(sinceTs) : shortDateTime(sinceTs)}`;

/** Strip over the top of a chronological log: messages unread since `sinceTs`, a jump to the first, and a dismiss. */
export function UnreadBanner(props: { count: number; sinceTs: number; onJump: () => void; onDismiss: () => void }) {
  return (
    // Overlay pinned to the top of the scroll area; placement is structural, look is in LogParts.module.css.
    <div class={styles.unreadBanner} role="status" style={{ position: 'absolute', top: 0, left: 0, right: 0 }}>
      <button type="button" class={styles.unreadJump} onClick={() => props.onJump()}>
        <span class={styles.unreadText}>{label(props.count, props.sinceTs)}</span>
        <span>Jump ↑</span>
      </button>
      <button type="button" class={styles.unreadDismiss} aria-label="Dismiss new messages" title="Dismiss" onClick={() => props.onDismiss()}>
        <Icon name="close" />
      </button>
    </div>
  );
}
