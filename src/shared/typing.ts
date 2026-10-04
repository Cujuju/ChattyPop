// The typing indicator's wording, Discord's: who is typing in a channel, as its clients phrase it.

/** Discord's client drops a typist this long after their last TYPING_START (clients send one about every 8–10 s). */
export const TYPING_TTL_MS = 10_000;
/** Named typists at most; beyond that Discord says "Several people". */
const NAMED_TYPISTS_MAX = 3;
/** Discord's word when no custom typing indicator applies. */
const DEFAULT_VERB = 'typing';

/** One person typing: their name, and their custom indicator's verb ("barking") when Discord sent one. */
export interface Typist {
  name: string;
  verb?: string;
}

/** The line's parts: names set in bold, the rest plain. */
export type TypingPart = { kind: 'name'; text: string } | { kind: 'text'; text: string };

/**
 * Discord's phrasing: "A is typing…", "A and B are typing…", "A, B, and C are typing…", "Several people are typing…".
 * A custom verb shows only while its owner types alone, as on Discord. Empty when no one types.
 */
export function typingParts(typists: readonly Typist[]): TypingPart[] {
  if (!typists.length) return [];
  if (typists.length > NAMED_TYPISTS_MAX) return [{ kind: 'text', text: `Several people are ${DEFAULT_VERB}…` }];
  const [only] = typists;
  if (typists.length === 1 && only) return [{ kind: 'name', text: only.name }, { kind: 'text', text: ` is ${only.verb ?? DEFAULT_VERB}…` }];
  const parts: TypingPart[] = [];
  typists.forEach((t, i) => {
    if (i > 0) parts.push({ kind: 'text', text: i === typists.length - 1 ? (typists.length > 2 ? ', and ' : ' and ') : ', ' });
    parts.push({ kind: 'name', text: t.name });
  });
  parts.push({ kind: 'text', text: ` are ${DEFAULT_VERB}…` });
  return parts;
}
