import { Show, onMount, type ComponentProps, type JSX } from 'solid-js';
import { PanelHeader } from './PanelHeader';
import { Icon } from './icons';
import styles from './ViewFailure.module.css';

export type FailureHeader = Pick<ComponentProps<typeof PanelHeader>, 'section' | 'panelId'>;
export type ViewFailureShown = 'line' | 'block' | 'page' | { header: FailureHeader };

/** Names the stopped view and offers one way on. */
export function ViewFailure(props: { name: string; shows: ViewFailureShown; error: unknown; repeated: boolean; refocus: boolean; onPress: (focused: boolean) => void }): JSX.Element {
  let element: HTMLElement | undefined;
  let button: HTMLButtonElement | undefined;
  const detail = (): string => props.error instanceof Error ? props.error.message : String(props.error);
  const firstLine = (): string => detail().split(/\r?\n/, 1)[0]!;
  const text = (): string => `${props.name} ${props.repeated ? "still isn't working." : 'stopped working.'}`;
  const press = (): void => props.onPress(Boolean(element?.contains(document.activeElement)));
  onMount(() => { if (props.refocus) button?.focus(); });
  const retry = (): JSX.Element => <button ref={button} type="button" class="cp-button" onClick={press}>Try again</button>;
  const body = (): JSX.Element => (
    <div ref={(el) => { if (typeof props.shows !== 'object') element = el; }} class={styles.block} role="status">
      <p class={styles.title}><Icon name="alert" class={styles.icon} />{text()}</p>
      <Show when={firstLine()}><p class={styles.detail} title={detail()}>{firstLine()}</p></Show>
      {retry()}
    </div>
  );
  if (props.shows === 'line') return (
    <p ref={(el) => element = el} class={styles.line} role="status"><Icon name="alert" class={styles.icon} /><span class={styles.text} title={detail()}>{text()}</span>{retry()}</p>
  );
  if (props.shows === 'page') return (
    <div ref={(el) => element = el} class={styles.page} role="alert">
      <p class={styles.title}><Icon name="alert" class={styles.icon} />ChattyPop stopped working.</p>
      <Show when={firstLine()}><p class={styles.detail} title={detail()}>{firstLine()}</p></Show>
      <p class={styles.hint}>Unsent messages and drafts are kept.</p>
      <button type="button" class="cp-primary" onClick={press}>Reload</button>
    </div>
  );
  if (typeof props.shows === 'object') return <section ref={(el) => element = el} class={styles.panel}><PanelHeader {...props.shows.header} title={props.name} collapsible />{body()}</section>;
  return body();
}
