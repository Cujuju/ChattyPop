import { Show, onMount } from 'solid-js';
import { DISCORD_TEXT_MAX } from '@shared/discord';
import { cancelEdit, editSession, editText, saveEdit, setEditText } from '@/state/ownMessages';
import { createAction } from '@/ui/action';
import { enterSends, enterToSend } from '@/ui/enterToSend';
import styles from './MessageEditor.module.css';

/** The edit session the editor last took focus for. */
let focusedSession: number | null = null;

/** In-place owner-message editor: desktop Enter saves, Shift+Enter adds lines, Escape cancels; phone Enter adds lines. Stops row gestures to preserve native editing. */
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
  // New edits focus at text end. Virtual-row restoration restores lost focus without scrolling/caret changes or stealing another field’s focus.
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
