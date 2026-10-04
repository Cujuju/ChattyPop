import styles from './Placeholder.module.css';

/** Stand-in body for a panel that has no implementation yet. */
export function Placeholder(props: { title: string }) {
  return (
    <section class={styles.root} aria-label={props.title}>
      <h2 class={styles.title}>{props.title}</h2>
    </section>
  );
}
