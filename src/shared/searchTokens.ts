// Search token vocabulary independent of plugin registries and the query parser.
/** Host-owned token names cannot be replaced by plugins. */
export const HOST_SEARCH_KEYS = ['from', 'in', 'server', 'has', 'is', 'before', 'after', 'during'] as const;
/** A declared parser token, as the search builder lists it. */
export interface SearchToken {
  key: string;
  /** What the token matches, e.g. "Carries one of your tags". */
  description: string;
  /** What its value is, shown after the key as a placeholder, e.g. "tag name". */
  value: string;
}
