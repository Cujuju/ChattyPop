// Discord's message-field keys, shared by the composer and the message editor.
import { inCompanion } from '@/state/ui';

/** Enter sends on the desktop, as in Discord's desktop app; on the phone it adds a line and a button sends, as in its mobile app. */
export const enterSends = !inCompanion;

/**
 * Where enabled, Enter sends and Shift+Enter inserts lines; a held Enter's repeats do neither (one that picked a
 * suggestion must not send). Line-break-only keyboard events send unless latest key held Shift; other contexts do nothing.
 */
export function enterToSend(send: () => void): { onKeyDown: (e: KeyboardEvent) => boolean; onBeforeInput: (e: InputEvent) => void } {
  if (!enterSends) return { onKeyDown: () => false, onBeforeInput: () => {} };
  let shiftHeld = false;
  return {
    /** True when it took the key (sent, or swallowed a repeat). */
    onKeyDown: (e) => {
      shiftHeld = e.shiftKey;
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return false;
      e.preventDefault();
      if (!e.repeat) send();
      return true;
    },
    onBeforeInput: (e) => {
      if ((e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') && !shiftHeld) {
        e.preventDefault();
        send();
      }
    },
  };
}
