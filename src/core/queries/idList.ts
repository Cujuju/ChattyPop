// A list bound as one SQL parameter (a JSON array): its length never meets SQLite's variable limit, as one variable per item would.

/** SQL true when `column` is one of the values bound at `param` as listParam(values). */
export const inListSql = (column: string, param = '?'): string => `${column} IN (SELECT value FROM json_each(${param}))`;

/** The value inListSql reads, bound where its `param` is. */
export const listParam = (values: readonly (string | number)[]): string => JSON.stringify(values);
