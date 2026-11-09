// A small window's own title bar (a panel window, the connect page): its title to drag by and the window buttons.
import { Show } from 'solid-js';
import type { WindowControls as Controls } from '@shared/windowControls';
import { createWindowFrameState } from './windowFrame';
import { AppLogo } from './AppLogo';
import { WindowControls } from './WindowControls';
import styles from './WindowBar.module.css';

export function WindowBar(props: { controls: Controls; title: string }) {
  const state = createWindowFrameState(props.controls);
  return (
    <header class={styles.bar} data-window-drag data-chrome={props.controls.chrome} data-full-screen={state().fullScreen || undefined}>
      <AppLogo class={styles.logo} />
      <span class={styles.title}>{props.title}</span>
      <Show when={props.controls.chrome === 'controls'}>
        <WindowControls controls={props.controls} />
      </Show>
    </header>
  );
}
