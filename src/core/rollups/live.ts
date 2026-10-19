import { MS_PER_S } from '@shared/units';
import { pendingChangesSql } from './changes';
import { pendingReferenceSql } from './privacy';

/** Pending names affect only the channels or authors named by the durable delta. */
export function metadataPartitionSql(id: string, channel: string, day?: string): string {
  return `EXISTS (SELECT 1 FROM rollup_metadata_pending mp
    WHERE EXISTS (SELECT 1 FROM rollup_kinds k WHERE k.rollup = '${id}'
      AND (k.kind = 'names' OR (mp.entity != 'user' AND k.kind = 'channels')))
    AND ((mp.entity = 'channel' AND mp.id = ${channel})
      OR (mp.entity = 'guild' AND EXISTS (SELECT 1 FROM channels c WHERE c.id = ${channel} AND c.guild_id = mp.id))
      OR (mp.entity = 'user' AND EXISTS (SELECT 1 FROM messages m WHERE m.author_id = mp.id AND m.channel_id = ${channel}
        ${day ? `AND m.ts >= unixepoch(${day}) * ${MS_PER_S} AND m.ts < unixepoch(${day}, '+1 day') * ${MS_PER_S}` : ''}))))`;
}

/** Enumerates missing daily summaries without scanning clean messages. Empty old partitions still clear deleted results. */
export function liveRollupSql(id: string, table: string, span?: { start: string; end: string; paddingMs: number }): string {
  return `SELECT p.channel_id, p.day FROM (
    SELECT channel_id, day FROM rollup_partitions WHERE rollup = '${id}'
    UNION SELECT channel_id, day FROM rollup_dirty WHERE rollup = '${id}' AND day != ''
    UNION SELECT c.channel_id, c.day FROM rollup_changes c JOIN rollup_kinds k ON k.kind = c.kind WHERE k.rollup = '${id}'
    UNION SELECT m.channel_id, date(m.ts / ${MS_PER_S}, 'unixepoch') FROM rollup_dirty d
      CROSS JOIN messages m ON m.channel_id = d.channel_id WHERE d.rollup = '${id}' AND d.day = '') p
    WHERE EXISTS (SELECT 1 FROM rollup_dirty d WHERE d.rollup = '${id}' AND d.channel_id = p.channel_id AND (d.day = p.day OR d.day = ''))
      OR ${pendingChangesSql(`'${id}'`, 'p.channel_id', 'p.day')}
      OR NOT (${pendingReferenceSql('p.channel_id', 'p.day')})
      OR ${metadataPartitionSql(id, 'p.channel_id', 'p.day')}
      ${span ? `OR EXISTS (SELECT 1 FROM rollup_span_dirty sd WHERE sd.rollup = '${id}' AND sd.channel_id = p.channel_id
        AND sd.first_day != '' AND p.day BETWEEN sd.first_day AND sd.last_day)
        OR EXISTS (SELECT 1 FROM rollup_span_inputs i CROSS JOIN ${table} r INDEXED BY ${table}_span
          WHERE i.rollup = '${id}' AND i.channel_id = p.channel_id AND r.channel_id = i.channel_id
          AND r.${span.start} < unixepoch(i.day, '+1 day') * ${MS_PER_S} + ${span.paddingMs}
          AND r.${span.end} >= unixepoch(i.day) * ${MS_PER_S} - ${span.paddingMs}
          AND p.day BETWEEN date(r.${span.start} / ${MS_PER_S}, 'unixepoch') AND date(r.${span.end} / ${MS_PER_S}, 'unixepoch'))` : ''}`;
}
