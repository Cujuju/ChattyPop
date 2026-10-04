// Discord's message-field keys, shared by the composer and the message editor.
import { inCompanion } from '@/state/ui';

/** Enter sends on the desktop, as in Discord's desktop app; on the phone it adds a line and a button sends, as in its mobile app. */
export const enterSends = !inCompanion;

/**
 * Where Enter sends (enterSends): Enter sends and Shift+Enter adds a line. Some keyboards report Enter only as a line
 * break being typed (no usable keydown), so that sends unless Shift was held at the last key. Elsewhere both are no-ops.
 */
export function enterToSend(send: () => void): { onKeyDown: (e: KeyboardEvent) => boolean; onBeforeInput: (e: InputEvent) => void } {
  if (!enterSends) return { onKeyDown: () => false, onBeforeInput: () => {} };
  let shiftHeld = false;
  return {
    /** True when the key sent. */
    onKeyDown: (e) => {
      shiftHeld = e.shiftKey;
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return false;
      e.preventDefault();
      send();
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
