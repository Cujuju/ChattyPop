// Shared status-bar label and value presentation.
import type { JSX } from 'solid-js';
import styles from './StatusBar.module.css';

/** A status label and value, with optional hover text and trailing content. */
export function StatusBarItem(props: {
  label: string;
  value: JSX.Element;
  title?: string;
  children?: JSX.Element;
}) {
  return (
    <span class={styles.item} title={props.title}>
      {props.label} <span class={styles.value}>{props.value}</span>{props.children}
    </span>
  );
}
