// Natural-language lists with no serial comma.
const joined = (items: readonly string[], conjunction: string): string =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} ${conjunction} ${items.at(-1)}` : items.join('');

/** Joins phrases with “and”. */
export const andList = (items: readonly string[]): string => joined(items, 'and');

/** Joins alternatives with “or”. */
export const orList = (items: readonly string[]): string => joined(items, 'or');
