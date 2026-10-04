// The search builder's catalog: every `key:` filter the parser accepts, grouped and described, with its value choices.
import { HAS_KINDS, IS_KINDS } from '@shared/searchQuery';
import type { SearchToken } from '@shared/searchTokens';

export interface FilterChoice {
  label: string;
  value: string;
}

export type FilterGroup = 'who' | 'what' | 'when';

export interface SearchFilter {
  key: string;
  group: FilterGroup;
  description: string;
  /** What the value is, shown after the key as a placeholder. */
  value: string;
  /** Values offered once the key is typed; empty for free-text values (names). */
  choices: () => readonly FilterChoice[];
}

export const FILTER_GROUPS: readonly { id: FilterGroup; title: string }[] = [
  { id: 'who', title: 'People & places' },
  { id: 'what', title: 'Content' },
  { id: 'when', title: 'Dates' },
];

const none = (): readonly FilterChoice[] => [];
const kinds = (list: readonly string[]) => (): readonly FilterChoice[] => list.map((k) => ({ label: k, value: k }));

const pad = (n: number): string => String(n).padStart(2, '0');
/** Today, this month, this year and last year, in the parser's period forms (parsePeriod). */
function dateChoices(): readonly FilterChoice[] {
  const now = new Date();
  const year = now.getFullYear();
  const month = `${year}-${pad(now.getMonth() + 1)}`;
  return [
    { label: 'Today', value: `${month}-${pad(now.getDate())}` },
    { label: 'This month', value: month },
    { label: 'This year', value: String(year) },
    { label: 'Last year', value: String(year - 1) },
  ];
}

const HOST_FILTERS: readonly SearchFilter[] = [
  { key: 'from', group: 'who', description: 'Sent by a person', value: 'name', choices: none },
  { key: 'in', group: 'who', description: 'In a channel', value: 'channel', choices: none },
  { key: 'server', group: 'who', description: 'In a server', value: 'server', choices: none },
  { key: 'has', group: 'what', description: 'Has a link, file, image or embed', value: 'kind', choices: kinds(HAS_KINDS) },
  { key: 'is', group: 'what', description: 'Edited or deleted', value: 'state', choices: kinds(IS_KINDS) },
  { key: 'before', group: 'when', description: 'Sent before a date', value: 'date', choices: dateChoices },
  { key: 'after', group: 'when', description: 'Sent after a date', value: 'date', choices: dateChoices },
  { key: 'during', group: 'when', description: 'Sent on a day, month or year', value: 'date', choices: dateChoices },
];

/** Host filters with the active plugins' tokens after the host's content filters. */
export function searchFilters(tokens: readonly SearchToken[]): SearchFilter[] {
  const plugin = tokens.map((t): SearchFilter => ({ key: t.key, group: 'what', description: t.description, value: t.value, choices: none }));
  const firstDate = HOST_FILTERS.findIndex((f) => f.group === 'when');
  return [...HOST_FILTERS.slice(0, firstDate), ...plugin, ...HOST_FILTERS.slice(firstDate)];
}

/** A trailing `key:` (optionally negated) still waiting for its value. */
const TRAILING_KEY = /(?:^|\s)-?([a-z][a-z0-9_]*):$/i;

/** The filter whose value is being typed at the end of `text`, if any. */
export function pendingFilter(text: string, filters: readonly SearchFilter[]): SearchFilter | undefined {
  const key = TRAILING_KEY.exec(text)?.[1]?.toLowerCase();
  return key === undefined ? undefined : filters.find((f) => f.key === key);
}

/** `text` with `key:` appended as a new term, ready for its value. */
export const withFilter = (text: string, key: string): string => `${text.trimEnd()}${text.trim() ? ' ' : ''}${key}:`;

/** `text` (ending in a pending `key:`) with `value` filled in and a space for the next term; spaced values are quoted. */
export const withValue = (text: string, value: string): string => `${text}${/\s/.test(value) ? `"${value}"` : value} `;
