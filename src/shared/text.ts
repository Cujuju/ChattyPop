/** A lone first half of a UTF-16 surrogate pair (an emoji or other character past U+FFFF) at the end. */
const TRAILING_HIGH_SURROGATE = /[\uD800-\uDBFF]$/;

/** Returns at most max UTF-16 units without splitting surrogate pairs, avoiding replacement characters and rejected Jev input. */
export function cutText(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return TRAILING_HIGH_SURROGATE.test(cut) ? cut.slice(0, -1) : cut;
}
