/** Text entry and pickers: a key typed here is input, never a shortcut. */
const TYPING_SELECTOR = 'input, textarea, select, [contenteditable], [role=combobox]';

/** The event's target is a field the user types into. */
export const isTypingTarget = (t: EventTarget | null): boolean => t instanceof Element && t.closest(TYPING_SELECTOR) !== null;

/** Controls Space presses (form inputs are typing targets already). */
const SPACE_CONTROL_SELECTOR = 'button, summary, [role=button], [role=checkbox], [role=switch], [role=radio], [role=tab], [role=menuitem], [role=option]';

/**
 * The target is a Space-pressed control the keyboard moved focus to (:focus-visible). A control a click focused is not:
 * after a click, Space is the leader key.
 */
export const spacePresses = (t: EventTarget | null): boolean => t instanceof Element && t.matches(':focus-visible') && t.closest(SPACE_CONTROL_SELECTOR) !== null;

/** The event's target is inside a window or menu (a <dialog> such as Jev check, or a context menu), which owns its keys. */
export const isInOverlay = (t: EventTarget | null): boolean => t instanceof Element && t.closest('dialog, [role=menu]') !== null;

/** The event's target is inside a window, menu or popup dialog (a picker), whose Escape closes it. */
export const isInEscapeOwner = (t: EventTarget | null): boolean => isInOverlay(t) || (t instanceof Element && t.closest('[role=dialog]') !== null);

/** keyCode of a key an input method processed: keydown while composing, and Safari's composition-ending Enter. */
const IME_PROCESS_KEY_CODE = 229;

/** The key belongs to an input method composing text (CJK conversion), not to the app (MDN's isComposing/229 test). */
export const isImeKey = (e: KeyboardEvent): boolean => e.isComposing || e.keyCode === IME_PROCESS_KEY_CODE;

/**
 * Keeps input-method keys from every app key handler in `win`: a window capture listener added before any other runs
 * first. Default actions are untouched, so the input method still gets its keys.
 */
export function holdImeKeys(win: EventTarget): void {
  win.addEventListener(
    'keydown',
    (e) => {
      if (isImeKey(e as KeyboardEvent)) e.stopImmediatePropagation();
    },
    true,
  );
}
