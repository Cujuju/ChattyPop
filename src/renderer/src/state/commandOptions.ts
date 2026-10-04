// A slash command's options as Discord's message bar takes them: typed text is the value of a text or number option;
// a choice, true/false, person, role or channel is picked from the list above the bar. DOM-free, so it is tested directly.
import { OPTION, type CommandOption, type OptionValue } from '@shared/commands';
import type { SelectKind } from '@shared/components';

/** A filled option: the value sent, and what its pill shows (a choice's or a person's name). */
export interface FilledOption {
  value: OptionValue;
  label: string;
}

export type EntityKind = Exclude<SelectKind, 'string'>;

const ENTITY_KINDS: Partial<Record<number, EntityKind>> = {
  [OPTION.user]: 'user',
  [OPTION.role]: 'role',
  [OPTION.mentionable]: 'mentionable',
  [OPTION.channel]: 'channel',
};

/** The people, roles or channels an option takes; null for other options. */
export const entityKind = (o: CommandOption): EntityKind | null => ENTITY_KINDS[o.type] ?? null;

const TRUE_FALSE: FilledOption[] = [
  { value: true, label: 'True' },
  { value: false, label: 'False' },
];

/** Its value must be picked from the list: typed text only narrows it. */
export const picksFromList = (o: CommandOption): boolean => o.type === OPTION.boolean || o.choices.length > 0 || entityKind(o) !== null;

const isNumeric = (o: CommandOption): boolean => o.type === OPTION.integer || o.type === OPTION.number;
const outside = (n: number, min: number | null, max: number | null): boolean => (min !== null && n < min) || (max !== null && n > max);

/**
 * Typed text as the option's value: text within its length limits, or a number (whole for integers) within its range.
 * Null when the text is empty or not a valid value, and always for options picked from a list or a file.
 */
export function typedValue(o: CommandOption, raw: string): FilledOption | null {
  if (raw === '' || picksFromList(o) || o.type === OPTION.attachment) return null;
  if (!isNumeric(o)) return outside(raw.length, o.minLength, o.maxLength) ? null : { value: raw, label: raw };
  const n = Number(raw);
  if (!raw.trim() || !Number.isFinite(n) || (o.type === OPTION.integer && !Number.isInteger(n)) || outside(n, o.minValue, o.maxValue)) return null;
  return { value: n, label: raw };
}

/** The option's own list (its choices, or True and False), narrowed to names containing `typed`, as Discord's is. */
export function listedChoices(o: CommandOption, typed: string): FilledOption[] {
  const all = o.type === OPTION.boolean ? TRUE_FALSE : o.choices.map((c) => ({ value: c.value, label: c.name }));
  const q = typed.trim().toLowerCase();
  return q ? all.filter((c) => c.label.toLowerCase().includes(q)) : all;
}

/** Optional options not yet in the bar whose names contain `typed`, in the command's order. */
export const optionalLeft = (options: CommandOption[], shown: string[], typed: string): CommandOption[] => {
  const q = typed.trim().toLowerCase();
  return options.filter((o) => !o.required && !shown.includes(o.name) && o.name.toLowerCase().includes(q));
};

/** What a people, role or channel search looks for: the pill's text without Discord's `@` or `#` sigil. */
export const entityQuery = (typed: string): string => typed.replace(/^[@#]/, '');
