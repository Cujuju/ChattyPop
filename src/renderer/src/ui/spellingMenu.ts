// Right-click spelling fixes: main forwards Chromium's misspelling and suggestions (main/spellingSuggestions.ts); the app's menu offers them.
import { onAppEvent } from '@/state/events';
import { setContextMenu } from '@/state/ui';

/** Puts the field's selection back where it was; false when the field changed since. */
type Restore = () => boolean;

/** The selection in `field` now: right-click has selected the misspelled word by the time main reports it. */
function selectionOf(field: HTMLElement): Restore | null {
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    const { selectionStart: start, selectionEnd: end, value } = field;
    if (start === null || end === null) return null;
    return () => field.value === value && (field.setSelectionRange(start, end), true);
  }
  const selection = window.getSelection();
  if (!field.isContentEditable || !selection?.rangeCount) return null;
  const range = selection.getRangeAt(0).cloneRange();
  if (!field.contains(range.startContainer) || !field.contains(range.endContainer)) return null;
  return () => {
    // A re-render replaced the word's nodes: its range no longer points into the field.
    if (!field.contains(range.startContainer) || !field.contains(range.endContainer)) return false;
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  };
}

/** Starts offering suggestions on misspelled words; once per window, before render. */
export function offerSpellingSuggestions(): void {
  // Main reports no position: the menu opens where the page saw the right-click (zoom-independent).
  let at = { x: 0, y: 0 };
  window.addEventListener('contextmenu', (e) => void (at = { x: e.clientX, y: e.clientY }), { capture: true });
  onAppEvent('spelling-suggestions', (e) => {
    const field = document.activeElement;
    if (!(field instanceof HTMLElement) || !e.suggestions.length) return;
    const restore = selectionOf(field);
    if (!restore) return;
    // The native edit keeps the field's own input handling and undo.
    const replace = (word: string): void => {
      field.focus({ preventScroll: true });
      if (restore()) document.execCommand('insertText', false, word);
    };
    setContextMenu({
      ...at,
      groups: [{ heading: `Replace “${e.word}” with`, items: e.suggestions.map((s) => ({ label: s, icon: 'edit', run: () => replace(s) })) }],
    });
  });
}
