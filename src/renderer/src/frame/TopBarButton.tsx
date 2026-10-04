// The top bar's icon button, shared by host items and plugin top-bar contributions so every item looks alike.
import { Show, type JSX } from 'solid-js';
import styles from './TopBar.module.css';

/** An icon button in the top bar; `badge` shows the unseen-items dot. */
export function TopBarButton(props: {
  label: string;
  title?: string;
  pressed?: boolean;
  badge?: boolean;
  onClick: () => void;
  /** The icon, given the host's icon class. */
  icon: (iconClass: string | undefined) => JSX.Element;
}) {
  return (
    <button
      type="button"
      class={styles.iconButton}
      aria-label={props.label}
      aria-pressed={props.pressed}
      title={props.title}
      onClick={() => props.onClick()}
    >
      {props.icon(styles.icon)}
      <Show when={props.badge}>
        <span class={styles.badgeDot} aria-hidden="true" />
      </Show>
    </button>
  );
}
