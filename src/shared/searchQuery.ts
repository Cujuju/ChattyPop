// Archive search query syntax: free words plus `key:value` operators, each negatable with a leading '-'.
// Shared so the renderer shows problems as the owner types, and core builds SQL from the same parse.

/** What `has:` can require of a message. */
export const HAS_KINDS = ['link', 'file', 'image', 'video', 'audio', 'voice', 'embed', 'sticker', 'poll', 'forward'] as const;
export type HasKind = (typeof HAS_KINDS)[number];

/** What `is:` can require of a message. */
export const IS_KINDS = ['edited', 'deleted'] as const;
export type IsKind = (typeof IS_KINDS)[number];

/** Operators with a name value (matched as a substring), a kind value, or a period value. */
const NAME_KEYS = ['from', 'in', 'server'] as const;
const PERIOD_KEYS = ['before', 'after', 'during'] as const;
export type SearchKey = (typeof NAME_KEYS)[number] | (typeof PERIOD_KEYS)[number] | 'has' | 'is';

export type SearchTerm =
  | { key: (typeof NAME_KEYS)[number]; value: string; negated: boolean }
  | { key: 'plugin'; token: string; value: string; negated: boolean }
  | { key: 'has'; value: HasKind; negated: boolean }
  | { key: 'is'; value: IsKind; negated: boolean }
  | { key: (typeof PERIOD_KEYS)[number]; period: Period; negated: boolean };

/** An operator that can't apply, with why; it is left out of the search rather than silently ignored. */
export interface SearchProblem {
  raw: string;
  reason: string;
}

export interface ParsedSearch {
  /** The free text left once operators are taken out. */
  words: string;
  terms: SearchTerm[];
  problems: SearchProblem[];
}

/** A local-time span [start, end) in ms: a day, month or year. */
export interface Period {
  start: number;
  end: number;
}

/** YYYY, YYYY-MM or YYYY-MM-DD. */
const PERIOD = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/;
const LAST_MONTH = 12;

/** A date value as the local-time period it names; null when it isn't a real date. */
export function parsePeriod(value: string): Period | null {
  const m = PERIOD.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = m[2] === undefined ? null : Number(m[2]) - 1;
  const day = m[3] === undefined ? null : Number(m[3]);
  if (month === null) return { start: new Date(year, 0, 1).getTime(), end: new Date(year + 1, 0, 1).getTime() };
  if (month < 0 || month >= LAST_MONTH) return null;
  if (day === null) return { start: new Date(year, month, 1).getTime(), end: new Date(year, month + 1, 1).getTime() };
  const start = new Date(year, month, day);
  // Date rolls an out-of-range day into the next month; that isn't the date typed.
  if (start.getMonth() !== month) return null;
  return { start: start.getTime(), end: new Date(year, month, day + 1).getTime() };
}

/** An operator token: optional '-', a known key, then a quoted or bare value. Other `word:` text (URLs) stays free text. */
const TERM = /(?:^|\s)(-?)([a-z][a-z0-9_]*):("[^"]*"|\S+)/gi;

const includes = <T extends string>(list: readonly T[], v: string): v is T => (list as readonly string[]).includes(v);

export function parseSearchQuery(text: string, pluginKeys: readonly string[] = []): ParsedSearch {
  const terms: SearchTerm[] = [];
  const problems: SearchProblem[] = [];
  const words = text.replace(TERM, (match: string, neg: string, rawKey: string, rawValue: string) => {
    const raw = match.trim();
    const key = rawKey.toLowerCase();
    if (![...NAME_KEYS, ...PERIOD_KEYS, 'has', 'is', ...pluginKeys].includes(key)) return match;
    const negated = neg === '-';
    const value = rawValue.replace(/^"|"$/g, '').trim();
    if (!value) problems.push({ raw, reason: 'needs a value' });
    else if (pluginKeys.includes(key)) terms.push({ key: 'plugin', token: key, value: value.replace(/^[#@]/, ''), negated });
    else if (includes(NAME_KEYS, key)) terms.push({ key, value: key === 'from' ? value : value.replace(/^[#@]/, ''), negated });
    else if (key === 'has' || key === 'is') {
      const kind = value.toLowerCase();
      if (key === 'has' && includes(HAS_KINDS, kind)) terms.push({ key, value: kind, negated });
      else if (key === 'is' && includes(IS_KINDS, kind)) terms.push({ key, value: kind, negated });
      else problems.push({ raw, reason: `unknown kind; use ${(key === 'has' ? HAS_KINDS : IS_KINDS).join(', ')}` });
    } else if (includes(PERIOD_KEYS, key)) {
      const period = parsePeriod(value);
      if (period) terms.push({ key, period, negated });
      else problems.push({ raw, reason: 'not a date; use YYYY-MM-DD, YYYY-MM or YYYY' });
    }
    return ' ';
  });
  return { words: words.replace(/\s+/g, ' ').trim(), terms, problems };
}

/** `from:<@id>` names one user exactly (Discord's mention form), as the person view links it. */
const USER_MENTION = /^<@!?([^>\s]+)>$/;
export const mentionedUserId = (value: string): string | null => USER_MENTION.exec(value)?.[1] ?? null;

/** A search query that finds one user's messages. */
export const fromUserQuery = (userId: string): string => `from:<@${userId}>`;

/** Saved searches, as stored: trimmed, non-empty, unique, in the owner's order. */
export function normalizeSavedSearches(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const queries = v.filter((x): x is string => typeof x === 'string').map((q) => q.trim());
  return [...new Set(queries.filter(Boolean))];
}
