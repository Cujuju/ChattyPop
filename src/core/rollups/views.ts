import { visibleChannelSql } from '../queries/privacy';
import { pendingReferenceSql } from './privacy';
import { pendingChangesSql } from './changes';
import { metadataPartitionSql } from './live';

/** Clean reads skip correlated guards; dirty reads retain partition checks and channel/range index constraints. */
export function visibleRollupSql(id: string, table: string, span: boolean, allTime = false): string {
  const ready = `(SELECT ready FROM rollup_reference_state WHERE singleton = 1) = 1
    AND (SELECT backfill FROM rollup_meta WHERE rollup = '${id}') = 0`;
  const day = allTime ? undefined : 'r.day';
  const clean = `NOT EXISTS (SELECT 1 FROM rollup_dirty WHERE rollup = '${id}')
    AND NOT ${pendingChangesSql(`'${id}'`)} AND NOT EXISTS (SELECT 1 FROM rollup_reference_catalog)
    AND NOT EXISTS (SELECT 1 FROM rollup_metadata_pending)
    ${span ? `AND NOT EXISTS (SELECT 1 FROM rollup_span_dirty WHERE rollup = '${id}')` : ''}`;
  const partitionClean = `NOT EXISTS (SELECT 1 FROM rollup_dirty d WHERE d.rollup = '${id}' AND d.channel_id = r.channel_id
    ${allTime ? '' : "AND (d.day = r.day OR d.day = '')"})`;
  const spanReady = !span ? '' : allTime
    ? `AND NOT EXISTS (SELECT 1 FROM rollup_span_dirty sd WHERE sd.rollup = '${id}' AND sd.channel_id = r.channel_id)`
    : `AND NOT EXISTS (SELECT 1 FROM "${table}_live_visible" sd WHERE sd.channel_id = r.channel_id AND sd.day = r.day)`;
  return `SELECT r.* FROM "${table}${allTime ? '_all_time' : ''}" r WHERE ${ready} AND ${visibleChannelSql('r.channel_id')}
    AND ((${clean}) OR (${partitionClean} ${spanReady}
      AND NOT ${pendingChangesSql(`'${id}'`, 'r.channel_id', day)} AND ${pendingReferenceSql('r.channel_id', day)}
      AND NOT ${metadataPartitionSql(id, 'r.channel_id', day)}))`;
}
