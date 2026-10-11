import type { CustomEmoji } from '@shared/emoji';

export type DraftFieldPart = { text: string; emoji?: CustomEmoji };

/** Only picked shortcuts and complete Discord markup become emoji; an unselected :name: stays editable text. */
export function draftFieldParts(text: string, picked: ReadonlyMap<string, CustomEmoji>): DraftFieldPart[] {
  const parts: DraftFieldPart[] = [];
  let end = 0;
  for (const match of text.matchAll(/<(a?):(\w{2,32}):(\d{15,21})>|(?<!<|<a):([\w~]+):/g)) {
    const emoji = match[4] ? picked.get(match[4]) : { name: match[2]!, id: match[3]!, animated: match[1] === 'a' };
    if (!emoji) continue;
    if (match.index > end) parts.push({ text: text.slice(end, match.index) });
    parts.push({ text: match[0], emoji });
    end = match.index + match[0].length;
  }
  if (end < text.length) parts.push({ text: text.slice(end) });
  return parts;
}

/** Caret offsets never divide a selected emoji's underlying shortcut/markup. */
export function draftFieldBoundary(parts: readonly DraftFieldPart[], offset: number, forward = false): number {
  let start = 0;
  for (const part of parts) {
    const end = start + part.text.length;
    if (part.emoji && offset > start && offset < end) return forward ? end : start;
    start = end;
  }
  return Math.max(0, Math.min(offset, start));
}
