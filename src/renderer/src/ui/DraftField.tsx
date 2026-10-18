// A draft remains plain text plus picked emoji IDs. Only its editing surface has atomic inline emoji images.
import { batchWrites, onCleanup } from '@plugin-sdk/renderer/containment';
import { createEffect } from 'solid-js';
import { DISCORD_TEXT_MAX } from '@shared/discord';
import { expandEmojiTokens } from '@shared/compose';
import { emojiUrl, type CustomEmoji } from '@shared/emoji';
import { customEmojiEntries, draftText, setDraftText } from '@/state/drafts';
import { draftFieldBoundary, draftFieldParts } from './draftFieldText';
import { draftFieldOffset, readDraftField, selectDraftField } from './draftFieldDom';
import { DraftFieldHistory, type FieldSelection } from './draftFieldHistory';
import styles from './DraftField.module.css';

/** The canonical draft's caret offsets, alongside the DOM field for sizing/focus. */
export interface DraftFieldHandle {
  readonly element: HTMLDivElement;
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  focus(): void;
  blur(): void;
  setSelectionRange(start: number, end: number): void;
  /** Inserts one undoable edit at the remembered selection. */
  replaceText(text: string, start?: number, end?: number, refocus?: boolean): void;
}

interface FieldProps {
  class?: string;
  label: string;
  placeholder: string;
  disabled?: boolean;
  enterkeyhint?: 'send' | 'enter' | 'done';
  ref: (handle: DraftFieldHandle) => void;
  onInput?: () => void;
  onBeforeInput?: (event: InputEvent) => void;
  onKeyDown?: (event: KeyboardEvent) => void;
  onKeyUp?: () => void;
  onClick?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onPaste?: (event: ClipboardEvent) => void;
  onDrop?: (event: DragEvent) => void;
}

/** The text an EmojiTextField edits. A new `textKey` resets its caret and undo history; `picked` maps `:token:`s to emoji. */
interface TextSource {
  textKey: string;
  text: () => string;
  setText: (text: string) => void;
  picked: () => ReadonlyMap<string, CustomEmoji>;
}

/** The composer's field over a channel's draft. */
export function DraftField(props: FieldProps & { channelId: string }) {
  return (
    <EmojiTextField {...props} textKey={props.channelId} text={() => draftText(props.channelId)}
      setText={(text) => setDraftText(props.channelId, text)} picked={() => new Map(customEmojiEntries(props.channelId))} />
  );
}

/** A text field showing picked shortcuts and Discord emoji markup as inline emoji images. */
export function EmojiTextField(props: FieldProps & TextSource) {
  let field!: HTMLDivElement;
  let replacing = false;
  let caret = { start: 0, end: 0 };
  let beforeEdit: FieldSelection = caret;
  let history = new DraftFieldHistory(props.text());
  let currentKey = props.textKey;
  const remember = (): void => {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !field.contains(selection.anchorNode) || !field.contains(selection.focusNode)) return;
    const range = selection.getRangeAt(0);
    caret = { start: draftFieldOffset(field, range.startContainer, range.startOffset), end: draftFieldOffset(field, range.endContainer, range.endOffset) };
  };
  const select = (start: number, end: number): void => {
    caret = { start, end };
    selectDraftField(field, start, end);
  };
  /** Creates every node/attribute ourselves; pasted HTML is never inserted. */
  const fragment = (text: string): HTMLDivElement => {
    const container = document.createElement('div');
    for (const part of draftFieldParts(text, props.picked())) {
      if (!part.emoji) container.append(document.createTextNode(part.text));
      else {
        const image = document.createElement('img');
        image.setAttribute('data-draft-emoji', part.text);
        image.contentEditable = 'false';
        image.draggable = false;
        image.className = styles.emoji ?? '';
        image.setAttribute('data-text-emoji', 'true');
        image.alt = `:${part.emoji.name}:`;
        image.src = emojiUrl(part.emoji);
        container.append(image);
      }
    }
    if (!text || text.endsWith('\n')) {
      const end = document.createElement('br');
      end.setAttribute('data-draft-end', 'true');
      container.append(end);
    }
    return container;
  };
  /** Writes the draft, then tells the owner. A listener's throw is reported, not raised: raised, it aborts the update and the draft's readers never run. */
  const commit = (text: string): void => batchWrites(() => {
    props.setText(text);
    try { props.onInput?.(); } catch (error) { reportError(error); }
  });
  const show = (text: string, selection: FieldSelection): void => {
    field.replaceChildren(...fragment(text).childNodes);
    select(Math.min(selection.start, text.length), Math.min(selection.end, text.length));
    commit(text);
  };
  /** Every edit reaches the draft. `composing`: the input method owns the DOM, so only the text is copied; the composition's end rewrites the field. */
  const publish = (typing = false, composing = false): void => {
    remember();
    const text = readDraftField(field);
    // Composition/autocorrect can edit without a cancellable beforeinput. Keep the textarea's original limit.
    if (text.length > DISCORD_TEXT_MAX) { if (!composing) show(props.text(), beforeEdit); return; }
    if (composing) return commit(text);
    history.record(text, beforeEdit, caret, typing);
    show(text, caret);
  };
  const travel = (redo: boolean): void => {
    const snapshot = redo ? history.redo() : history.undo();
    if (snapshot) show(snapshot.text, snapshot);
  };
  const handle: DraftFieldHandle = {
    get element() { return field; },
    get value() { return readDraftField(field); },
    get selectionStart() { remember(); return caret.start; },
    get selectionEnd() { remember(); return caret.end; },
    focus: () => field.focus(), blur: () => field.blur(), setSelectionRange: select,
    replaceText: (text, start = handle.selectionStart, end = handle.selectionEnd, refocus = true) => {
      if (props.disabled) return;
      const parts = draftFieldParts(handle.value, props.picked());
      const selected = start !== end;
      start = draftFieldBoundary(parts, start);
      end = draftFieldBoundary(parts, end, selected);
      const room = DISCORD_TEXT_MAX - (handle.value.length - (end - start));
      if (text.length > room) return;
      const focused = document.activeElement === field;
      // A phone pick kept open returns focus to its picker afterwards.
      const previous = document.activeElement as HTMLElement | null;
      replacing = true;
      field.focus();
      const value = handle.value.slice(0, start) + text + handle.value.slice(end);
      const after = { start: start + text.length, end: start + text.length };
      history.record(value, { start, end }, after);
      show(value, after);
      replacing = false;
      if (!refocus && !focused) previous?.focus();
      else if (refocus && !focused) props.onFocus?.();
    },
  };
  // The text changed elsewhere (sent, restored, another channel): the field shows it, ending a composition under way.
  createEffect(() => {
    const text = props.text();
    if (!field) return;
    const changedKey = currentKey !== props.textKey;
    if (changedKey) { currentKey = props.textKey; caret = { start: text.length, end: text.length }; }
    if (!changedKey && readDraftField(field) === text) return;
    history = new DraftFieldHistory(text);
    if (!changedKey) remember();
    field.replaceChildren(...fragment(text).childNodes);
    if (document.activeElement === field) select(Math.min(caret.start, text.length), Math.min(caret.end, text.length));
  });
  const clipboard = (event: ClipboardEvent, cut: boolean): void => {
    remember();
    if (caret.start === caret.end) return;
    event.preventDefault();
    event.clipboardData?.setData('text/plain', expandEmojiTokens(handle.value.slice(caret.start, caret.end), props.picked()));
    if (cut) handle.replaceText('');
  };
  const selectionChanged = (): void => remember();
  document.addEventListener('selectionchange', selectionChanged);
  onCleanup(() => document.removeEventListener('selectionchange', selectionChanged));
  // Filled at creation, so an owner's onMount can already place the caret in the text.
  return <div ref={(element) => { field = element; field.replaceChildren(...fragment(props.text()).childNodes); props.ref(handle); }} class={`${styles.field} ${props.class ?? ''}`}
    role="textbox" aria-label={props.label} aria-multiline="true" aria-disabled={props.disabled || undefined}
    contentEditable={!props.disabled} tabIndex={props.disabled ? -1 : 0} enterkeyhint={props.enterkeyhint}
    data-placeholder={props.placeholder} data-empty={!props.text()} spellcheck="true"
    onInput={(event) => publish(event.inputType === 'insertText', event.isComposing)}
    onCompositionStart={() => { remember(); beforeEdit = { ...caret }; }}
    onCompositionEnd={() => publish()}
    onBeforeInput={(event) => {
      if (event.isComposing) return;
      props.onBeforeInput?.(event);
      if (event.defaultPrevented || replacing) return;
      remember(); beforeEdit = { ...caret };
      if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') { event.preventDefault(); travel(event.inputType === 'historyRedo'); return; }
      if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') { event.preventDefault(); handle.replaceText('\n'); return; }
      if (event.inputType.startsWith('format')) event.preventDefault();
      if (event.inputType === 'insertText' && event.data && handle.value.length - (handle.selectionEnd - handle.selectionStart) + event.data.length > DISCORD_TEXT_MAX) event.preventDefault();
    }}
    onKeyDown={(event) => {
      if (!event.isComposing && (event.ctrlKey || event.metaKey) && !event.altKey && (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')) {
        event.preventDefault(); travel(event.key.toLowerCase() === 'y' || event.shiftKey); return;
      }
      props.onKeyDown?.(event);
    }} onKeyUp={props.onKeyUp} onClick={props.onClick}
    onFocus={() => { if (!replacing) props.onFocus?.(); }} onBlur={() => { remember(); if (!replacing) props.onBlur?.(); }}
    onCopy={(event) => clipboard(event, false)} onCut={(event) => clipboard(event, true)}
    onPaste={(event) => {
      props.onPaste?.(event);
      if (event.defaultPrevented) return;
      event.preventDefault();
      handle.replaceText(event.clipboardData?.getData('text/plain') ?? '');
    }}
    onDrop={(event) => {
      props.onDrop?.(event);
      if (event.defaultPrevented) return;
      event.preventDefault();
      handle.replaceText(event.dataTransfer?.getData('text/plain') ?? '');
    }} />;
}
