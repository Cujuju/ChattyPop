// Native showModal confirmations size to content and close via Escape/backdrop/button. Persistent adjacent tools use FloatingWindows.
import { createEffect, onCleanup, type JSX } from 'solid-js';
import { setOverlayCover } from '@/state/windows';
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
  createEffect(() => {
    if (props.open && !el.open) el.showModal();
    else if (!props.open && el.open) el.close();
    setOverlayCover(props.id, props.open ? 'window' : null);
  });
  onCleanup(() => setOverlayCover(props.id, null));
  return (
    <dialog
      ref={el}
      class={styles.dialog}
      data-size={props.size}
      aria-label={props.title}
      // Esc: the UA's cancel closes it; onClose keeps the owner's state in step.
      onClose={() => props.onClose()}
      // A click on the backdrop lands on the dialog itself.
      onClick={(e) => e.target === e.currentTarget && props.onClose()}
    >
      <WindowHeader title={props.title} classes={chrome} closeLabel="Cancel" onClose={() => props.onClose()} />
      <div class={styles.body}>{props.children}</div>
    </dialog>
  );
}
