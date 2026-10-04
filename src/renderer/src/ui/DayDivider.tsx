import styles from './LogParts.module.css';

/** Day heading between rows of a chronological list: rows show only the time, as the Archive does. */
export const dayLabel = (ms: number): string => new Date(ms).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

export function DayDivider(props: { label: string }) {
  return (
    <div class={styles.day} role="separator">
      {props.label}
    </div>
  );
}
