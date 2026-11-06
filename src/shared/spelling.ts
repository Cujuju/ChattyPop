import { find } from 'linkifyjs';

/** A word to check in draft text; offsets index the text, `end` exclusive. */
export interface SpellingWord { start: number; end: number; word: string }

/** Words in draft text worth checking, excluding markup, URLs, code, and digit/underscore tokens. */
export function spellingWords(text: string): SpellingWord[] {
  // Mask in UTF-16 code units so offsets still index the original draft, including after emoji.
  const spaces = (value: string): string => value.replace(/[^\r\n]/g, ' ');
  let plain = text.replace(/```[\s\S]*?(?:```|$)|`[^`\r\n]*(?:`|$)|<(?:a?:[^:>]+:\d+|@(?:!|&)?\d+|#\d+|t:[^>]+)>|:[\w+-]+:/g, spaces);
  for (const link of find(plain)) {
    plain = plain.slice(0, link.start) + spaces(plain.slice(link.start, link.end)) + plain.slice(link.end);
  }
  return [...plain.matchAll(/[\p{L}\p{N}_]+(?:['’][\p{L}\p{N}_]+)*/gu)]
    .filter(([word]) => !/[\p{N}_]/u.test(word))
    .map((match) => ({ start: match.index, end: match.index + match[0].length, word: match[0] }));
}

export const SUGGESTION_MAX = 5;

/** Adjacent-swap matches first, followed by Hunspell's order, capped at SUGGESTION_MAX. */
export function rankSuggestions(word: string, suggestions: readonly string[]): string[] {
  const letters = [...word.toLowerCase()];
  const swaps = new Set(letters.slice(1).map((_, i) =>
    [...letters.slice(0, i), letters[i + 1], letters[i], ...letters.slice(i + 2)].join('')).filter((swap) => swap !== word.toLowerCase()));
  return [...suggestions].sort((a, b) => Number(swaps.has(b.toLowerCase())) - Number(swaps.has(a.toLowerCase())))
    .slice(0, SUGGESTION_MAX);
}
