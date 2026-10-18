// Views know visibility; scoped readers additionally constrain every metadata source before selecting or matching text.
import type { ArchiveToolScope } from '../ai/archiveTools';
import { LINK_METADATA_FIELDS } from '../derive/linkMetadata';
import { displayNameSql } from './names';
import { noHiddenRefSql, visibleMessageRefSql, visibleMessageSql } from './privacy';

export type LinkMetadataField = typeof LINK_METADATA_FIELDS[number];
/** One eligible supplier is sufficient; its channel records precisely the evidence used by this reader. */
const metadataSupplierSql = (l: string, field: LinkMetadataField, scope: string): string =>
  `SELECT s.channel_id FROM message_links sm JOIN messages s ON s.id = sm.message_id
    WHERE sm.link_id = ${l}.id AND sm.metadata_${field} = ${l}.${field}
      AND ${visibleMessageSql('s')} AND ${noHiddenRefSql(`${l}.${field}`)} AND (${scope})`;

/** Unknown provenance, missing/removed shares and hidden source messages never supply metadata. */
export function linkMetadataAllowedSql(l: string, field: LinkMetadataField, scope = '1'): string {
  return `(${l}.${field} IS NOT NULL AND EXISTS (${metadataSupplierSql(l, field, scope)}))`;
}

export const linkMetadataFieldSql = (l: string, field: LinkMetadataField, scope = '1'): string =>
  `CASE WHEN ${linkMetadataAllowedSql(l, field, scope)} THEN ${l}.${field} END`;

/** Explicit columns retain the archive link contract; all-data readers preserve rows, with the same metadata protection. */
export function archiveLinksSql(scope = '1', all = false, provenance = false): string {
  return `SELECT l.id, l.url, l.platform, ${LINK_METADATA_FIELDS.map((f) => `${linkMetadataFieldSql('l', f, scope)} AS ${f}`).join(', ')},
    l.first_message_id, l.first_channel_id, l.first_author_id, l.first_ts,
    ${displayNameSql('l.first_author_id', 'l.first_channel_id')} AS author_name
    ${provenance ? `, json_array(${LINK_METADATA_FIELDS.map((f) => `CASE WHEN l.${f} IS NOT NULL THEN (${metadataSupplierSql('l', f, scope)} LIMIT 1) END`).join(', ')}) AS metadata_channel_ids` : ''}
    FROM links l LEFT JOIN users u ON u.id = l.first_author_id
    ${all ? '' : `WHERE ${visibleMessageRefSql('l.first_channel_id', 'l.first_message_id')} AND ${noHiddenRefSql('l.url')}`}`.trimEnd();
}

const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** Scope values are SQL literals, never executable SQL or placeholders that interfere with a caller's parameters. */
export function metadataScopeSql(scope: ArchiveToolScope): string {
  for (const bound of [scope.since, scope.until]) if (bound !== null && !Number.isFinite(bound)) throw new RangeError('Invalid metadata window.');
  if (!scope.channelIds.length) return '0';
  if (scope.since !== null && scope.until !== null && scope.since > scope.until) throw new RangeError('Reversed metadata window.');
  return [`s.channel_id IN (SELECT value FROM json_each(${literal(JSON.stringify(scope.channelIds))}))`,
    ...(scope.since === null ? [] : [`s.ts >= ${scope.since}`]), ...(scope.until === null ? [] : [`s.ts <= ${scope.until}`])].join(' AND ');
}
