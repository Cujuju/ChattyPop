// Keyword patterns: comma-separated keywords or /regex/, and the builder's structured rule compiled to one; what a
// rule's keyword match stores and tests with.

/** Any of, all of, none of: each list holds words or phrases; `*` stands for any letters or digits, `?` for one. */
export interface PatternSpec {
  /** The message contains at least one of these. */
  anyOf: string[];
  /** …and every one of these. */
  allOf: string[];
  /** …and none of these. */
  noneOf: string[];
  /** Terms match whole words only ("art" doesn't match "start"). */
  wholeWords: boolean;
  matchCase: boolean;
}

export const EMPTY_PATTERN_SPEC: PatternSpec = { anyOf: [], allOf: [], noneOf: [], wholeWords: true, matchCase: false };

/** A word character for wildcards and word edges: any letter or digit, in any script. */
const WORD_CHAR = '[\\p{L}\\p{N}]';
const escape = (s: string): string => s.replace(/[.+^${}()|[\]\\/]/g, '\\$&');

/** One term as regex source: escaped text, glob wildcards, any run of spaces for a space, optional word edges. */
export function termSource(term: string, wholeWords: boolean): string {
  const body = escape(term.trim())
    .replace(/\*/g, `${WORD_CHAR}*`)
    .replace(/\?/g, WORD_CHAR)
    .replace(/\s+/g, '\\s+');
  return wholeWords ? `(?<!${WORD_CHAR})${body}(?!${WORD_CHAR})` : body;
}

const clean = (terms: string[]): string[] => [...new Set(terms.map((t) => t.trim()).filter(Boolean))];

/** Why a spec can't become a pattern, or null when it can. */
export function specProblem(spec: PatternSpec): string | null {
  if (!clean(spec.anyOf).length && !clean(spec.allOf).length) return 'Add at least one word to “Contains any of” or “Contains all of”.';
  // Reject wildcard-only terms that match nearly all text.
  const bare = [...spec.anyOf, ...spec.allOf, ...spec.noneOf].map((t) => t.trim()).find((t) => t && !/[\p{L}\p{N}]/u.test(t.replace(/[*?]/g, '')));
  return bare ? `“${bare}” needs at least one letter or digit besides * and ?.` : null;
}

/** Compiles match terms as snippet/highlight targets. Start-anchored lookbehinds evaluate remaining conditions across the whole message. */
export function buildPattern(spec: PatternSpec): string {
  const problem = specProblem(spec);
  if (problem) throw new Error(problem);
  const src = (terms: string[]): string[] => clean(terms).map((t) => termSource(t, spec.wholeWords));
  const any = src(spec.anyOf);
  const all = src(spec.allOf);
  const none = src(spec.noneOf);
  const conditions = [...all.map((t) => `(?=[\\s\\S]*?${t})`), ...none.map((t) => `(?![\\s\\S]*?${t})`)];
  const consumed = `(?:${(any.length ? any : all).join('|')})`;
  const guard = conditions.length ? `(?<=^${conditions.join('')}[\\s\\S]*)` : '';
  return `/${consumed}${guard}/${spec.matchCase ? 'u' : 'iu'}`;
}

/** Start and end of each match in `text` (at most `max`), for highlighting. */
export function matchRanges(re: RegExp, text: string, max: number): [number, number][] {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const out: [number, number][] = [];
  for (let m = g.exec(text); m && out.length < max; m = g.exec(text)) {
    if (m[0].length === 0) {
      g.lastIndex++; // Reject empty matches to prevent loops.
      continue;
    }
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

export const isPatternSpec = (v: unknown): v is PatternSpec => {
  const s = v as Partial<PatternSpec> | null;
  const list = (x: unknown): boolean => Array.isArray(x) && x.every((t) => typeof t === 'string');
  return !!s && list(s.anyOf) && list(s.allOf) && list(s.noneOf) && typeof s.wholeWords === 'boolean' && typeof s.matchCase === 'boolean';
};

const REGEX_PATTERN = /^\/(.+)\/([a-z]*)$/s;
export const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Compiles /regex/flags or comma-separated whole-word/phrase keywords. Missing regex flags default to case-insensitive; invalid regex throws. */
export function compileKeywordPattern(pattern: string): RegExp {
  const re = REGEX_PATTERN.exec(pattern.trim());
  // g/y dropped: a reused regex must not carry lastIndex between test() calls.
  if (re) return new RegExp(re[1]!, (re[2] || 'i').replace(/[gy]/g, ''));
  const terms = pattern
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => escapeRegex(t).replace(/\s+/g, '\\s+'));
  if (!terms.length) throw new Error('Enter a keyword or /regex/.');
  // Letter/number boundaries (not \b) so terms like "1.7.2" or "C++" match as written.
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.join('|')})(?![\\p{L}\\p{N}])`, 'iu');
}

/** A keyword/regex matcher; null for an empty pattern. Throws on a bad regex. */
export const keywordRegex = (pattern: string): RegExp | null => (pattern.trim() ? compileKeywordPattern(pattern) : null);

/** A name for a rule matching `pattern`: the keywords, or the regex source. */
export const patternName = (pattern: string): string => {
  const re = REGEX_PATTERN.exec(pattern.trim());
  return re ? re[1]! : pattern.trim();
};

/** A recent archived message a pattern matched, for the keyword editor's check. */
export interface PatternPreviewHit {
  messageId: string;
  channelId: string;
  channelName: string;
  authorName: string;
  ts: number;
  /** Text around the match. */
  text: string;
}

export interface PatternPreview {
  /** Newest first, a limited number. */
  hits: PatternPreviewHit[];
  /** Every match among the scanned messages. */
  matched: number;
  scanned: number;
  /** Start of the window searched. */
  sinceTs: number;
}
