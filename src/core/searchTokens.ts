// Active plugin search conditions; unloading removes the token from the core parser too.
/** A bound condition over messages alias m and the plugin's own tables. */
export interface SearchCondition {
  sql: string;
  params: (string | number)[];
}
/** Reads a token's value without interpolating it into SQL. */
export type SearchTokenReader = (value: string) => SearchCondition;
const readers = new Map<string, SearchTokenReader>();
/** Registers a token and returns an identity-safe disposer. */
export function registerSearchToken(key: string, read: SearchTokenReader): () => void {
  if (readers.has(key)) throw new Error(`Search token ${key} already registered.`);
  readers.set(key, read);
  return () => {
    if (readers.get(key) === read) readers.delete(key);
  };
}
/** Active tokens for the core parser. */
export const searchTokenKeys = (): string[] => [...readers.keys()];
/** An active condition; failure is guarded by its plugin context and matches nothing. */
export const searchTokenCondition = (key: string, value: string): SearchCondition => readers.get(key)?.(value) ?? {
  sql: '0',
  params: [],
};
