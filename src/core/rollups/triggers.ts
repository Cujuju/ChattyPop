import { installMetadataTriggers } from './metadata';
import { reconcileDefinition } from './definitions';
import type { Db } from '../db';
import { MS_PER_S } from '@shared/units';
import { installRollupChanges } from './changes';

/** Message payload changes include edits to embeds and flags; reaction/poll tables retain their own change kinds. */
const MESSAGE_COLUMNS = ['content', 'channel_id', 'ts', 'deleted_at', 'pruned_at', 'author_id', 'edited_ts', 'raw_json'];

/** Durable invalidation includes both sides when a message, attachment or first link share moves between partitions. */
export function installRollupTriggers(db: Db): void {
  installMetadataTriggers(db);
  installRollupChanges(db);
  const mark = (alias: string, channel: string, ts: string, kinds: string[]) => `
    INSERT INTO rollup_changes(channel_id, day, kind)
      SELECT ${alias}.${channel}, date(${alias}.${ts} / ${MS_PER_S}, 'unixepoch'), column1
      FROM (VALUES ${kinds.map((kind) => `('${kind}')`).join(', ')}) WHERE ${alias}.${ts} IS NOT NULL
      ON CONFLICT(channel_id, day, kind) DO NOTHING;`;
  const missing = (alias: string, channel: string, ts: string, kinds: string[]) => `(${alias}.${ts} IS NOT NULL AND (
    ${kinds.map((kind) => `NOT EXISTS (SELECT 1 FROM rollup_changes WHERE channel_id = ${alias}.${channel}
      AND day = date(${alias}.${ts} / ${MS_PER_S}, 'unixepoch') AND kind = '${kind}')`).join(' OR ')}))`;
  for (const [table, channel, ts, kind] of [
    ['messages', 'channel_id', 'ts', 'messages'], ['attachments', 'channel_id', 'ts', 'attachments'],
    ['links', 'first_channel_id', 'first_ts', 'links'],
  ] as const) {
    const changed = kind === 'messages' ? ['edits', 'deletes'] : [kind];
    const columns = table === 'messages' ? MESSAGE_COLUMNS : db.prepare('SELECT name FROM pragma_table_info(?)').pluck().all(table) as string[];
    const updateColumns = table === 'messages' ? ` OF ${columns.join(', ')}` : '';
    const changedRow = columns.map((column) => `old."${column}" IS NOT new."${column}"`).join(' OR ');
    reconcileDefinition(db, `rollup/${table}`, `CREATE TRIGGER IF NOT EXISTS rollup_${table}_insert AFTER INSERT ON ${table}
      WHEN ${missing('new', channel, ts, [kind])}
      BEGIN ${mark('new', channel, ts, [kind])} END;
      CREATE TRIGGER IF NOT EXISTS rollup_${table}_update AFTER UPDATE${updateColumns} ON ${table} WHEN (${changedRow})
        AND (${missing('old', channel, ts, changed)} OR ${missing('new', channel, ts, changed)})
      BEGIN ${mark('old', channel, ts, changed)} ${mark('new', channel, ts, changed)} END;
      CREATE TRIGGER IF NOT EXISTS rollup_${table}_delete AFTER DELETE ON ${table}
      WHEN ${missing('old', channel, ts, table === 'messages' ? ['deletes'] : [kind])}
      BEGIN ${mark('old', channel, ts, table === 'messages' ? ['deletes'] : [kind])} END;`);
  }
}
