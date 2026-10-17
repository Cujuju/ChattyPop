// The three archive text indexes, shared by app and plugin search.

/** Builds a parameterized union over message, derived and link text, selecting over message alias `m`. */
export function searchIndexUnion(
  query: string,
  select: (fts: string) => string,
  joins: string,
  filters: string,
  params: readonly (string | number)[],
): { sql: string; params: (string | number)[] } {
  const sources = [
    ['fts_messages', 'fts_messages f JOIN messages m ON m.seq = f.rowid'],
    ['fts_derived_texts', 'fts_derived_texts fd JOIN derived_texts d ON d.seq = fd.rowid JOIN messages m ON m.id = d.message_id'],
    ['fts_links', 'fts_links fl JOIN message_links ml ON ml.link_id = fl.rowid JOIN messages m ON m.id = ml.message_id'],
  ] as const;
  return {
    sql: sources.map(([fts, from]) => `${select(fts)} FROM ${from} ${joins} WHERE ${fts} MATCH ?${filters}`).join(' UNION ALL '),
    params: sources.flatMap(() => [query, ...params]),
  };
}
