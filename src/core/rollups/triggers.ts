import type { Db } from '../db';
import { MS_PER_S } from '@shared/units';

/** Message payload changes include edits to embeds and flags; reaction/poll tables retain their own change kinds. */
const MESSAGE_COLUMNS = ['content', 'channel_id', 'ts', 'deleted_at', 'pruned_at', 'author_id', 'edited_ts', 'raw_json'];

/** Durable invalidation includes both sides when a message, attachment or first link share moves between partitions. */
export function installRollupTriggers(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS rollup_kinds (rollup TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (rollup, kind));`);
  const mark = (alias: string, channel: string, ts: string, kinds: string[]) => `
    INSERT INTO rollup_dirty(rollup, channel_id, day)
      SELECT DISTINCT rollup, ${alias}.${channel}, date(${alias}.${ts} / ${MS_PER_S}, 'unixepoch') FROM rollup_kinds
      WHERE kind IN (${kinds.map((k) => `'${k}'`).join(', ')})
      ON CONFLICT(rollup, channel_id, day) DO UPDATE SET revision = revision + 1;`;
  for (const [table, channel, ts, kind] of [
    ['messages', 'channel_id', 'ts', 'messages'], ['attachments', 'channel_id', 'ts', 'attachments'],
    ['links', 'first_channel_id', 'first_ts', 'links'],
  ] as const) {
    const changed = kind === 'messages' ? ['edits', 'deletes'] : [kind];
    const columns = table === 'messages' ? MESSAGE_COLUMNS : db.prepare('SELECT name FROM pragma_table_info(?)').pluck().all(table) as string[];
    const updateColumns = table === 'messages' ? ` OF ${columns.join(', ')}` : '';
    const changedRow = columns.map((column) => `old."${column}" IS NOT new."${column}"`).join(' OR ');
    db.exec(`CREATE TRIGGER IF NOT EXISTS rollup_${table}_insert AFTER INSERT ON ${table}
      BEGIN ${mark('new', channel, ts, [kind])} END;
      CREATE TRIGGER IF NOT EXISTS rollup_${table}_update AFTER UPDATE${updateColumns} ON ${table} WHEN ${changedRow}
      BEGIN ${mark('old', channel, ts, changed)} ${mark('new', channel, ts, changed)} END;
      CREATE TRIGGER IF NOT EXISTS rollup_${table}_delete AFTER DELETE ON ${table}
      BEGIN ${mark('old', channel, ts, table === 'messages' ? ['deletes'] : [kind])} END;`);
  }
}
