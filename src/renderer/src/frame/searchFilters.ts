// The search builder's catalog: every `key:` filter the parser accepts, grouped and described, with its value choices.
import { HAS_KINDS, IS_KINDS } from '@shared/searchQuery';
import type { SearchToken } from '@shared/searchTokens';

/** A person's avatar, a server's icon, or a channel's sigil ('#'). */
export type ChoiceLead =
  | { kind: 'person'; id: string; avatar: string | null }
  | { kind: 'server'; id: string; name: string; icon: string | null }
  | { kind: 'channel'; sigil: string };

export interface FilterChoice {
  label: string;
  value: string;
  /** A second, quieter line: a person's @username, a channel's server. */
  detail?: string;
  /** What shows before the label of a named choice. */
  lead?: ChoiceLead;
  /** A term added after the value to narrow it, as `server:` after a channel name other servers share too. */
  narrow?: string;
}

export type FilterChoices = readonly FilterChoice[] | Promise<readonly FilterChoice[]>;

export type FilterGroup = 'who' | 'what' | 'when';

export interface SearchFilter {
  key: string;
  group: FilterGroup;
  description: string;
  /** What the value is, shown after the key as a placeholder. */
  value: string;
  /** Values matching what is typed after the key so far (`partial`, maybe empty); none for free text. */
  choices: (partial: string) => FilterChoices;
  /** Choices are named things (people, places), listed as rows; else short values, shown as chips. */
  named?: boolean;
}

/** Where the people, channels and servers the `from:`, `in:` and `server:` filters offer come from. */
export interface NamedChoiceSources {
  people: (partial: string) => FilterChoices;
  channels: (partial: string) => FilterChoices;
  servers: (partial: string) => FilterChoices;
}

export const FILTER_GROUPS: readonly { id: FilterGroup; title: string }[] = [
  { id: 'who', title: 'People & places' },
  { id: 'what', title: 'Content' },
  { id: 'when', title: 'Dates' },
];

const none = (): readonly FilterChoice[] => [];
const NO_NAMED_CHOICES: NamedChoiceSources = { people: none, channels: none, servers: none };

/** The choices whose label or value contains `partial`, ignoring case. */
export const matching = (choices: readonly FilterChoice[], partial: string): readonly FilterChoice[] => {
  const p = partial.toLowerCase();
  return choices.filter((c) => c.label.toLowerCase().includes(p) || c.value.toLowerCase().includes(p));
};

const kinds = (list: readonly string[]) => (partial: string): readonly FilterChoice[] =>
  matching(
    list.map((k) => ({ label: k, value: k })),
    partial,
  );

const pad = (n: number): string => String(n).padStart(2, '0');
/** Today, this month, this year and last year, in the parser's period forms (parsePeriod). */
function dateChoices(partial: string): readonly FilterChoice[] {
  const now = new Date();
  const year = now.getFullYear();
  const month = `${year}-${pad(now.getMonth() + 1)}`;
  const all = [
    { label: 'Today', value: `${month}-${pad(now.getDate())}` },
    { label: 'This month', value: month },
    { label: 'This year', value: String(year) },
    { label: 'Last year', value: String(year - 1) },
  ];
  return matching(all, partial);
}

const hostFilters = (named: NamedChoiceSources): readonly SearchFilter[] => [
  { key: 'from', group: 'who', description: 'Sent by a person', value: 'name', choices: named.people, named: true },
  { key: 'in', group: 'who', description: 'In a channel', value: 'channel', choices: named.channels, named: true },
  { key: 'server', group: 'who', description: 'In a server', value: 'server', choices: named.servers, named: true },
  { key: 'has', group: 'what', description: 'Has a link, file, image or embed', value: 'kind', choices: kinds(HAS_KINDS) },
  { key: 'is', group: 'what', description: 'Edited or deleted', value: 'state', choices: kinds(IS_KINDS) },
  { key: 'before', group: 'when', description: 'Sent before a date', value: 'date', choices: dateChoices },
  { key: 'after', group: 'when', description: 'Sent after a date', value: 'date', choices: dateChoices },
  { key: 'during', group: 'when', description: 'Sent on a day, month or year', value: 'date', choices: dateChoices },
];

/** Host filters with the active plugins' tokens after the host's content filters. */
export function searchFilters(tokens: readonly SearchToken[], named: NamedChoiceSources = NO_NAMED_CHOICES): SearchFilter[] {
  const host = hostFilters(named);
  const plugin = tokens.map((t): SearchFilter => ({ key: t.key, group: 'what', description: t.description, value: t.value, choices: none }));
  const firstDate = host.findIndex((f) => f.group === 'when');
  return [...host.slice(0, firstDate), ...plugin, ...host.slice(firstDate)];
}

/** A trailing `key:` (optionally negated) and the value typed after it so far: unquoted, or an open quote. */
const TRAILING_TERM = /(?:^|\s)(-?)([a-z][a-z0-9_]*):("[^"]*|[^\s"]*)$/i;

/** The filter whose value is being typed at the end of a query, and that value so far. */
export interface PendingFilter {
  filter: SearchFilter;
  /** The value typed so far, without its opening quote. */
  partial: string;
  negated: boolean;
}

/** The filter whose value is being typed at the end of `text`, if any. */
export function pendingFilter(text: string, filters: readonly SearchFilter[]): PendingFilter | undefined {
  const m = TRAILING_TERM.exec(text);
  const filter = m && filters.find((f) => f.key === m[2]!.toLowerCase());
  return filter ? { filter, partial: m[3]!.replace(/^"/, ''), negated: m[1] === '-' } : undefined;
}

/** `text` with `key:` appended as a new term, ready for its value. */
export const withFilter = (text: string, key: string): string => `${text.trimEnd()}${text.trim() ? ' ' : ''}${key}:`;

const quoted = (value: string): string => (/\s/.test(value) ? `"${value}"` : value);

/**
 * `text` (ending in a `key:` and maybe part of its value) with the value replaced by `value`, then `narrow` when
 * given, and a space for the next term; spaced values are quoted.
 */
export function withValue(text: string, value: string, narrow?: string): string {
  const typed = TRAILING_TERM.exec(text)?.[3] ?? '';
  return `${text.slice(0, text.length - typed.length)}${quoted(value)} ${narrow ? `${narrow} ` : ''}`;
}

/** `text` with the pending value set to `choice`. A negated term drops `narrow`, which would stay un-negated. */
export const withChoice = (text: string, pending: PendingFilter, choice: FilterChoice): string =>
  withValue(text, choice.value, pending.negated ? undefined : choice.narrow);

/** The `server:` term naming one server. */
export const serverTerm = (name: string): string => `server:${quoted(name)}`;
