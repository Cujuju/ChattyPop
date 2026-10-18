// Shared archive query parser handles free words and negatable key:value operators. Renderer diagnostics and core SQL use identical parsing.
import { oneOf } from './normalize';

/** Result orders: by time either way, or best match first (full-text score, then plugins' search rankers). */
export const SEARCH_SORTS = ['newest', 'oldest', 'relevance'] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];
export const DEFAULT_SEARCH_SORT: SearchSort = 'newest';
export const normalizeSearchSort = (v: unknown): SearchSort => oneOf(SEARCH_SORTS, v, DEFAULT_SEARCH_SORT);

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

/** One operator read: the term it adds, why it can't apply, or null when the key is no operator (free text). */
type TermReading = { term: SearchTerm } | { problem: string } | null;

/** A key the parser reads as an operator: the host's, or an active plugin's token. */
const isOperatorKey = (key: string, pluginKeys: readonly string[]): boolean => [...NAME_KEYS, ...PERIOD_KEYS, 'has', 'is', ...pluginKeys].includes(key.toLowerCase());

function readTerm(neg: string, rawKey: string, rawValue: string, pluginKeys: readonly string[]): TermReading {
  const key = rawKey.toLowerCase();
  if (!isOperatorKey(key, pluginKeys)) return null;
  const negated = neg === '-';
  const value = rawValue.replace(/^"|"$/g, '').trim();
  if (!value) return { problem: 'needs a value' };
  if (pluginKeys.includes(key)) return { term: { key: 'plugin', token: key, value: value.replace(/^[#@]/, ''), negated } };
  if (includes(NAME_KEYS, key)) return { term: { key, value: key === 'from' ? value : value.replace(/^[#@]/, ''), negated } };
  if (key === 'has' || key === 'is') {
    const kind = value.toLowerCase();
    if (key === 'has' && includes(HAS_KINDS, kind)) return { term: { key, value: kind, negated } };
    if (key === 'is' && includes(IS_KINDS, kind)) return { term: { key, value: kind, negated } };
    return { problem: `unknown kind; use ${(key === 'has' ? HAS_KINDS : IS_KINDS).join(', ')}` };
  }
  const period = parsePeriod(value);
  return period ? { term: { key: key as (typeof PERIOD_KEYS)[number], period, negated } } : { problem: 'not a date; use YYYY-MM-DD, YYYY-MM or YYYY' };
}

export function parseSearchQuery(text: string, pluginKeys: readonly string[] = []): ParsedSearch {
  const terms: SearchTerm[] = [];
  const problems: SearchProblem[] = [];
  const words = text.replace(TERM, (match: string, neg: string, rawKey: string, rawValue: string) => {
    const read = readTerm(neg, rawKey, rawValue, pluginKeys);
    if (!read) return match;
    if ('term' in read) terms.push(read.term);
    else problems.push({ raw: match.trim(), reason: read.problem });
    return ' ';
  });
  return { words: words.replace(/\s+/g, ' ').trim(), terms, problems };
}

/**
 * A query as the search field draws it: free text, or an operator (`-`, key and colon, then its value). A term whose
 * value is still being typed at the end (`key:` or an open quote) is `typing`, not yet judged.
 */
export type QuerySpan = { kind: 'text'; text: string } | { kind: 'term'; key: string; value: string; state: 'ok' | 'problem' | 'typing' };

/** A trailing operator whose value is empty or an unclosed quote. */
const TYPING_TERM = /(?:^|\s)(-?)([a-z][a-z0-9_]*):("[^"]*)?$/i;

/** `text` cut into spans the parser reads the same way; their texts joined are `text` exactly. */
export function searchQuerySpans(text: string, pluginKeys: readonly string[] = []): QuerySpan[] {
  const spans: QuerySpan[] = [];
  const addText = (t: string): void => {
    if (!t) return;
    const last = spans.at(-1);
    if (last?.kind === 'text') last.text += t;
    else spans.push({ kind: 'text', text: t });
  };
  const t = TYPING_TERM.exec(text);
  const typing = t && isOperatorKey(t[2]!, pluginKeys) ? { key: `${t[1]}${t[2]}:`, value: t[3] ?? '' } : null;
  const head = typing ? text.slice(0, text.length - typing.key.length - typing.value.length) : text;
  let at = 0;
  for (const m of head.matchAll(TERM)) {
    const [whole, neg, rawKey, rawValue] = m as unknown as [string, string, string, string];
    const read = readTerm(neg, rawKey, rawValue, pluginKeys);
    if (!read) continue;
    const end = m.index + whole.length;
    const start = end - (neg.length + rawKey.length + 1 + rawValue.length); // after TERM's leading space
    addText(head.slice(at, start));
    spans.push({ kind: 'term', key: `${neg}${rawKey}:`, value: rawValue, state: 'term' in read ? 'ok' : 'problem' });
    at = end;
  }
  addText(head.slice(at));
  if (typing) spans.push({ kind: 'term', ...typing, state: 'typing' });
  return spans;
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
