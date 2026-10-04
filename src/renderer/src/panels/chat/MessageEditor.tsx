import { Show, onMount } from 'solid-js';
import { DISCORD_TEXT_MAX } from '@shared/discord';
import { cancelEdit, editSession, editText, saveEdit, setEditText } from '@/state/ownMessages';
import { createAction } from '@/ui/action';
import { enterSends, enterToSend } from '@/ui/enterToSend';
import styles from './MessageEditor.module.css';

/** The edit session the editor last took focus for. */
let focusedSession: number | null = null;

/**
 * Discord's in-place editor for one of the owner's messages, in place of its text: Enter saves (on the desktop; on the phone it
 * adds a line and the hint's save link saves), Shift+Enter adds a line, Esc cancels. The row's own touch and menu gestures
 * stop here, so the field keeps its native ones.
 */
export function MessageEditor() {
  const action = createAction();
  let input!: HTMLTextAreaElement;
  const save = (): void => {
    if (!action.busy()) void action.run(saveEdit);
  };
  const enter = enterToSend(save);
  const onKeyDown = (e: KeyboardEvent): void => {
    if (enter.onKeyDown(e) || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    cancelEdit();
  };
  // A new Edit takes the focus with the caret at the end. The log re-creates a row scrolled away and back: that only
  // restores focus its removal dropped, without scrolling or moving the caret, and never takes it from another field.
  onMount(() => {
    const session = editSession();
    if (session !== focusedSession) {
      focusedSession = session;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    } else if (document.activeElement === document.body) input.focus({ preventScroll: true });
  });

  return (
    <div class={styles.root} onContextMenu={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()} onTouchMove={(e) => e.stopPropagation()} onTouchEnd={(e) => e.stopPropagation()}>
      <textarea
        ref={input}
        class={styles.input}
        rows={1}
        maxLength={DISCORD_TEXT_MAX}
        aria-label="Edit message"
        value={editText()}
        disabled={action.busy()}
        enterkeyhint={enterSends ? 'done' : 'enter'}
        onInput={(e) => setEditText(e.currentTarget.value)}
        onKeyDown={onKeyDown}
        onBeforeInput={enter.onBeforeInput}
      />
      <p class={styles.hint}>
        escape to{' '}
        <button type="button" class={styles.link} onClick={cancelEdit}>
          cancel
        </button>{' '}
        • {enterSends ? 'enter to ' : ''}
        <button type="button" class={styles.link} disabled={action.busy()} onClick={save}>
          save
        </button>
      </p>
      <Show when={action.error()}>
        <p class="cp-error" role="alert">
          {action.error()}
        </p>
      </Show>
    </div>
  );
}
