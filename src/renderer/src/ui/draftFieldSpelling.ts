// Underlines a draft field's misspelled words (CSS Custom Highlight API) and offers fixes: right-click, or a tap on the phone.
import { onCleanup } from '@plugin-sdk/renderer/containment';
import { createEffect, on } from 'solid-js';
import type { SpellingWord } from '@shared/spelling';
import { failureNotice } from '@/state/dialogs';
import { addToDictionary, misspellings, spellingRevision, spellingSuggestions } from '@/state/spelling';
import { inCompanion } from '@/state/ui';
import { draftFieldRange, readDraftField } from './draftFieldDom';
import type { FieldSelection } from './draftFieldHistory';
import { openSpellingMenu } from './spellingMenu';

/** The theme draws it: ::highlight(cp-misspelled). */
const HIGHLIGHT_NAME = 'cp-misspelled';
/** Each field's underlined ranges, all in one shared highlight. */
const drawn = new Map<HTMLElement, Range[]>();
let highlight: Highlight | null = null;

function draw(field: HTMLElement, ranges: Range[]): void {
  // Without the API (older phone browsers) words stay unmarked; nothing else depends on it.
  if (!('highlights' in CSS)) return;
  if (!highlight) CSS.highlights.set(HIGHLIGHT_NAME, (highlight = new Highlight()));
  for (const range of drawn.get(field) ?? []) highlight.delete(range);
  if (ranges.length) drawn.set(field, ranges);
  else drawn.delete(field);
  for (const range of ranges) highlight.add(range);
}

const within = (word: SpellingWord, offset: number): boolean => offset >= word.start && offset <= word.end;
const hits = (range: Range, x: number, y: number): boolean =>
  [...range.getClientRects()].some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);

export interface DraftSpelling {
  /** The text or caret changed: re-mark. */
  update(): void;
  /** A typed edit left the caret at `offset`: that word stays unmarked until the caret leaves it. */
  typed(offset: number): void;
  onContextMenu(event: MouseEvent): void;
  onClick(event: MouseEvent): void;
}

/** `caret`: the field's selection while focused, else null. `replace`: one undoable edit of draft offsets. */
export function draftFieldSpelling(field: () => HTMLElement, caret: () => FieldSelection | null, replace: (text: string, start: number, end: number) => void): DraftSpelling {
  let checked: { text: string; words: SpellingWord[] } | null = null;
  let marked: SpellingWord[] = [];
  let typingAt: number | null = null;
  let request = 0;

  const mark = (): void => {
    const at = caret();
    const typing = typingAt === null ? undefined : checked?.words.find((w) => within(w, typingAt!));
    if (!typing || !(at && at.start === at.end && within(typing, at.start))) typingAt = null;
    marked = (checked?.words ?? []).filter((w) => typingAt === null || !within(w, typingAt));
    draw(field(), marked.map((w) => draftFieldRange(field(), w.start, w.end)));
  };
  // Until a check returns, the drawn ranges stay: they move with the edit, so other words don't flicker while typing.
  const update = (): void => {
    const text = readDraftField(field());
    if (checked?.text === text) return mark();
    const id = ++request;
    void misspellings(text).then((words) => {
      if (id !== request || readDraftField(field()) !== text) return;
      checked = { text, words };
      mark();
    });
  };
  /** The marked word under a viewport point, if the field still holds it. */
  const wordAt = (x: number, y: number): SpellingWord | null => {
    const text = readDraftField(field());
    return marked.find((w) => text.slice(w.start, w.end) === w.word && hits(draftFieldRange(field(), w.start, w.end), x, y)) ?? null;
  };
  const offer = async (word: SpellingWord, x: number, y: number): Promise<void> => {
    const suggestions = await spellingSuggestions(word.word);
    openSpellingMenu({ x, y }, word.word, suggestions, {
      replace: (fix) => {
        if (readDraftField(field()).slice(word.start, word.end) === word.word) replace(fix, word.start, word.end);
      },
      add: () => void addToDictionary(word.word).catch(failureNotice(`Couldn't add “${word.word}” to your dictionary`)),
    });
  };

  // Loaded dictionary or changed owner words: every word is re-checked.
  createEffect(on(spellingRevision, () => { checked = null; update(); }));
  onCleanup(() => { request++; draw(field(), []); });

  return {
    update,
    typed: (offset) => void (typingAt = offset),
    onContextMenu: (event) => {
      const word = wordAt(event.clientX, event.clientY);
      if (!word) return;
      event.preventDefault();
      void offer(word, event.clientX, event.clientY);
    },
    // The phone has no right-click: tapping a marked word offers its fixes.
    onClick: (event) => {
      if (!inCompanion) return;
      const word = wordAt(event.clientX, event.clientY);
      if (word) void offer(word, event.clientX, event.clientY);
    },
  };
}
