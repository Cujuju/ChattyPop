// A button in a hovered message's bar, shared by the host's hover-bar items and plugins' so every button looks alike.
import type { JSX } from 'solid-js';
import styles from './MessageActionBar.module.css';

/** An icon button in the message hover bar, labelled and titled `label`. */
export function HoverBarButton(props: {
  label: string;
  onClick: (e: MouseEvent & { currentTarget: HTMLButtonElement }) => void;
  /** The icon, given the host's icon class. */
  icon: (iconClass: string | undefined) => JSX.Element;
}) {
  return (
    <button type="button" class={styles.button} aria-label={props.label} title={props.label} onClick={(e) => props.onClick(e)}>
      {props.icon(styles.icon)}
    </button>
  );
}
