// An input method's keys (CJK conversion) belong to it: no app key handler (list pickers, New message's Enter) sees them.
import { describe, expect, it, vi } from 'vitest';

/** keyCode browsers give a key an input method processed. */
const IME_PROCESS_KEY_CODE = 229;
/** Enter's keyCode. */
const ENTER_KEY_CODE = 13;

// Renderer modules: imported by path so the node type-check doesn't follow them into DOM types.
const keysPath = '../src/renderer/src/ui/keys';
const listNavPath = '../src/renderer/src/ui/listNav';
const { holdImeKeys } = (await import(keysPath)) as { holdImeKeys(win: EventTarget): void };
const { createListNav } = (await import(listNavPath)) as {
  createListNav(count: () => number, opts: { onEnter: (i: number) => void; onEscape: () => void; activeEl: () => null }): { onKey(e: Event): void };
};

/** A keydown as the window gets it; Node has no KeyboardEvent, so its fields are set on an Event. */
const keydown = (key: string, isComposing: boolean, keyCode = isComposing ? IME_PROCESS_KEY_CODE : ENTER_KEY_CODE): Event =>
  Object.assign(new Event('keydown', { cancelable: true }), { key, isComposing, keyCode });

/** A window with the guard installed first, then a picker's list navigation listening as the app's handlers do. */
function pickerWindow() {
  const win = new EventTarget();
  holdImeKeys(win);
  const onEnter = vi.fn();
  const onEscape = vi.fn();
  const nav = createListNav(() => 2, { onEnter, onEscape, activeEl: () => null });
  win.addEventListener('keydown', (e) => nav.onKey(e));
  return { win, onEnter, onEscape };
}

describe('input method keys', () => {
  it('a composing Enter or Escape picks nothing and keeps its default for the input method', () => {
    const { win, onEnter, onEscape } = pickerWindow();
    for (const k of ['Enter', 'Escape', 'ArrowDown']) {
      const e = keydown(k, true);
      win.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
    }
    expect(onEnter).not.toHaveBeenCalled();
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("Safari's composition-ending Enter (not composing, keyCode 229) is the input method's too", () => {
    const { win, onEnter } = pickerWindow();
    win.dispatchEvent(keydown('Enter', false, IME_PROCESS_KEY_CODE));
    expect(onEnter).not.toHaveBeenCalled();
  });

  it('the next Enter, after composition ends, picks', () => {
    const { win, onEnter } = pickerWindow();
    win.dispatchEvent(keydown('Enter', true));
    const e = keydown('Enter', false);
    win.dispatchEvent(e);
    expect(onEnter).toHaveBeenCalledOnce();
    expect(e.defaultPrevented).toBe(true);
  });
});
