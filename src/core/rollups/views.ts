import { visibleChannelSql } from '../queries/privacy';
import { pendingReferenceSql } from './privacy';
import { pendingChangesSql } from './changes';

/** Clean reads skip correlated guards; dirty reads retain partition checks and channel/range index constraints. */
export function visibleRollupSql(id: string, table: string, span: boolean, allTime = false): string {
  const ready = `(SELECT ready FROM rollup_reference_state WHERE singleton = 1) = 1
    AND (SELECT backfill FROM rollup_meta WHERE rollup = '${id}') = 0`;
  const day = allTime ? undefined : 'r.day';
  const clean = `NOT EXISTS (SELECT 1 FROM rollup_dirty WHERE rollup = '${id}')
    AND NOT ${pendingChangesSql(`'${id}'`)} AND NOT EXISTS (SELECT 1 FROM rollup_reference_catalog)
    ${span ? `AND NOT EXISTS (SELECT 1 FROM rollup_span_dirty WHERE rollup = '${id}')` : ''}`;
  const partitionClean = `NOT EXISTS (SELECT 1 FROM rollup_dirty d WHERE d.rollup = '${id}' AND d.channel_id = r.channel_id
    ${allTime ? '' : "AND (d.day = r.day OR d.day = '')"})`;
  const spanReady = span ? `AND NOT EXISTS (SELECT 1 FROM rollup_span_dirty sd WHERE sd.rollup = '${id}' AND sd.channel_id = r.channel_id
    ${allTime ? '' : 'AND r.day BETWEEN sd.first_day AND sd.last_day'})` : '';
  return `SELECT r.* FROM "${table}${allTime ? '_all_time' : ''}" r WHERE ${ready} AND ${visibleChannelSql('r.channel_id')}
    AND ((${clean}) OR (${partitionClean} ${spanReady}
      AND NOT ${pendingChangesSql(`'${id}'`, 'r.channel_id', day)} AND ${pendingReferenceSql('r.channel_id', day)}))`;
}
