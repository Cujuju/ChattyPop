// How a message matched a rule.
/** alerts.match_kind: how the message matched. The rule itself (keywords, contents, a direct hit) is `pattern`; Jev is `meaning`. */
export const MATCH_KIND = { pattern: 'pattern', meaning: 'meaning' } as const;
export type MatchKind = (typeof MATCH_KIND)[keyof typeof MATCH_KIND];

/** How a rule matched a message: the kind, Jev's probability for a meaning match, and the keywords to centre the snippet on. */
export interface Hit {
  kind: MatchKind;
  probability: number | null;
  highlight: RegExp | null;
}

