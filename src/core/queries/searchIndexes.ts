// The three archive text indexes, shared by app and plugin search.
import { linkMetadataAllowedSql } from './linkMetadata';
import { pluginLinkTextSql } from './messageText';

/** Builds a parameterized union over message, derived and link text, selecting over message alias `m`. */
export function searchIndexUnion(
  query: string,
  select: (fts: string) => string,
  joins: string,
  filters: string,
  params: readonly (string | number)[],
  metadataScope: { sql: string; params: readonly (string | number)[] },
): { sql: string; params: (string | number)[] } {
  // CROSS JOIN keeps each FTS index ahead of candidate lookups, regardless of channel size or planner statistics.
  const sources = [
    ['fts_messages', 'fts_messages f CROSS JOIN messages m ON m.seq = f.rowid'],
    ['fts_derived_texts', 'fts_derived_texts fd CROSS JOIN derived_texts d ON d.seq = fd.rowid CROSS JOIN messages m ON m.id = d.message_id'],
    ['fts_links', 'fts_links fl CROSS JOIN links l ON l.id = fl.rowid CROSS JOIN message_links ml ON ml.link_id = fl.rowid CROSS JOIN messages m ON m.id = ml.message_id'],
  ] as const;
  return {
    sql: sources.map(([fts, from]) => `${select(fts)} FROM ${from} ${joins} WHERE ${fts} MATCH ?${filters}${fts === 'fts_links' ?
      ` AND (${pluginLinkTextSql('l')} IS NOT NULL OR ((${linkMetadataAllowedSql('l', 'title', metadataScope.sql)} OR l.title IS NULL)
        AND (${linkMetadataAllowedSql('l', 'description', metadataScope.sql)} OR l.description IS NULL)))` : ''}`).join(' UNION ALL '),
    params: sources.flatMap(([fts]) => [query, ...params, ...(fts === 'fts_links' ? [...metadataScope.params, ...metadataScope.params] : [])]),
  };
}
