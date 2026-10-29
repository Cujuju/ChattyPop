// Stored JSON read in SQL without throwing: SQLite's JSON functions throw on malformed input, so damaged text reads as NULL.

/** SQL `json` when it is well-formed JSON text, else NULL. */
export const validJsonSql = (json: string): string => `(SELECT CASE WHEN json_valid(j) THEN j END FROM (SELECT ${json} AS j))`;

/** SQL reading JSON `path` (a constant, never user text) from a JSON text column such as roles.raw_json; NULL when damaged. */
export const storedJsonSql = (column: string, path: string): string => `json_extract(${validJsonSql(column)}, '${path}')`;
