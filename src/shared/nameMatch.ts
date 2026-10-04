// How typed text matches a name for `@` suggestions: shared by the archive's ranking and the composer's open list.

/** Compared without case, accents or width: "Éva" and "ｅｖａ" both read "eva". */
export const foldName = (s: string): string => s.normalize('NFKD').replace(/\p{M}+/gu, '').toLocaleLowerCase();

/** A loose match: `query`'s characters appear in `text` in order, gaps allowed. Both already folded. */
export function subsequence(query: string, text: string): boolean {
  let at = 0;
  for (const ch of query) {
    at = text.indexOf(ch, at) + 1;
    if (at === 0) return false;
  }
  return true;
}

/** Whether any of `names` still matches `query` at all (the loosest tier). */
export const anyNameMatches = (query: string, names: readonly string[]): boolean => {
  const q = foldName(query.trim());
  return names.some((n) => subsequence(q, foldName(n)));
};
