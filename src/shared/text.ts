/** A lone first half of a UTF-16 surrogate pair (an emoji or other character past U+FFFF) at the end. */
const TRAILING_HIGH_SURROGATE = /[\uD800-\uDBFF]$/;

/**
 * The first `max` UTF-16 units of `s`, never ending on half a character: a cut through an emoji leaves invalid Unicode,
 * which renders as a replacement box and which Jev rejects outright.
 */
export function cutText(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return TRAILING_HIGH_SURROGATE.test(cut) ? cut.slice(0, -1) : cut;
}
