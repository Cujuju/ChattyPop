// Native showModal confirmations size to content and close via Escape/backdrop/button. Persistent adjacent tools use FloatingWindows.
import { onCleanup } from '@plugin-sdk/renderer/containment';
import { createEffect, type JSX } from 'solid-js';
import { setOverlayCover } from '@/state/windows';
import { syncDialog } from './dialogSync';
import { WindowHeader } from './FloatingWindow';
import chrome from './WindowChrome.module.css';
import styles from './ModalDialog.module.css';

export function ModalDialog(props: {
  /** Its overlay id while open (the live Discord view, a native layer, is hidden under it). */
  id: string;
  open: boolean;
  title: string;
  /** wide: content that reads better wide (a whole file); else a form's width. */
  size?: 'wide';
  onClose: () => void;
  children: JSX.Element;
}) {
  let el!: HTMLDialogElement;
  const onNativeClose = syncDialog(() => el, () => props.open, { request: () => props.onClose() }, 'modal');
  createEffect(() => setOverlayCover(props.id, props.open ? 'window' : null));
  onCleanup(() => setOverlayCover(props.id, null));
  return (
    <dialog
      ref={el}
      class={styles.dialog}
      data-size={props.size}
      aria-label={props.title}
      onClose={onNativeClose}
      // A click on the backdrop lands on the dialog itself.
      onClick={(e) => e.target === e.currentTarget && props.onClose()}
    >
      <WindowHeader title={props.title} classes={chrome} closeLabel="Cancel" onClose={() => props.onClose()} />
      <div class={styles.body}>{props.children}</div>
    </dialog>
  );
}
