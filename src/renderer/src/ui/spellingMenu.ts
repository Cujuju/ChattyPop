// Spelling fix menus. Message fields run the app's checker (draftFieldSpelling.ts); other text fields keep Chromium's, whose
// misspelling main forwards (main/spellingSuggestions.ts).
import { onAppEvent } from '@/state/events';
import { setContextMenu } from '@/state/ui';
import type { MenuGroup } from './menuTypes';

/** Puts the field's selection back where it was; false when the field changed since. */
type Restore = () => boolean;

/** Opens the fixes for `word` at a viewport point: its suggestions, then Add to dictionary when the checker keeps one. */
export function openSpellingMenu(at: { x: number; y: number }, word: string, suggestions: readonly string[], actions: { replace: (fix: string) => void; add?: () => void }): void {
  const groups: MenuGroup[] = [];
  if (suggestions.length) groups.push({ heading: `Replace “${word}” with`, items: suggestions.map((s) => ({ label: s, icon: 'edit', run: () => actions.replace(s) })) });
  const { add } = actions;
  if (add) groups.push({ heading: suggestions.length ? undefined : `No suggestions for “${word}”`, items: [{ label: 'Add to dictionary', icon: 'plus', run: add }] });
  if (groups.length) setContextMenu({ ...at, groups });
}

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

/** Starts offering Chromium's suggestions on misspelled words; once per window, before render. */
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
    openSpellingMenu(at, e.word, e.suggestions, {
      replace: (word) => {
        field.focus({ preventScroll: true });
        if (restore()) document.execCommand('insertText', false, word);
      },
    });
  });
}
