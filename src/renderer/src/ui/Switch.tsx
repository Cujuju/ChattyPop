import styles from './Switch.module.css';

/** An on/off switch: a checkbox with role="switch", so it keeps native keyboard and form behaviour. */
export function Switch(props: { checked: boolean; onChange: (on: boolean) => void; label?: string; id?: string; disabled?: boolean; title?: string }) {
  return (
    <input
      id={props.id}
      class={styles.switch}
      type="checkbox"
      role="switch"
      aria-label={props.label}
      title={props.title}
      checked={props.checked}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.currentTarget.checked)}
    />
  );
}
