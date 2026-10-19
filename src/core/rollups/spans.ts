import { reconcileDefinition } from './definitions';
import type { Db } from '../db';
import { MS_PER_S } from '@shared/units';

/** Durable nonlocal invalidation covers merged runs and every possible opener after a deletion splits a run. */
export function installSpanTriggers(db: Db, id: string, table: string, columns: object, span: { start: string; end: string; paddingMs: number }): void {
  if (!Object.hasOwn(columns, span.start) || !Object.hasOwn(columns, span.end) || !Number.isSafeInteger(span.paddingMs) || span.paddingMs < 0) throw new Error('Invalid rollup span');
  const prefix = table.replace(/_v\d+$/, '_v');
  const old = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name GLOB ?").all(`${prefix}*_span_*`) as { name: string }[];
  for (const trigger of old) if (!trigger.name.startsWith(`${table}_span_`)) db.exec(`DROP TRIGGER "${trigger.name.replace(/"/g, '""')}"`);
  db.exec(`CREATE INDEX IF NOT EXISTS "${table}_span" ON "${table}" (channel_id, "${span.start}", "${span.end}")`);
  const mark = (alias: string) => `INSERT INTO rollup_span_dirty(rollup, channel_id, first_day, last_day)
      SELECT DISTINCT '${id}', channel_id, date("${span.start}" / ${MS_PER_S}, 'unixepoch'), date("${span.end}" / ${MS_PER_S}, 'unixepoch')
      FROM "${table}" WHERE channel_id = ${alias}.channel_id
        AND "${span.start}" <= ${alias}.ts + ${span.paddingMs} AND "${span.end}" >= ${alias}.ts - ${span.paddingMs}
    ON CONFLICT(rollup, channel_id, first_day, last_day) DO UPDATE SET revision = revision + 1;`;
  for (const [operation, body] of [['insert', mark('new')], ['delete', mark('old')], ['update', mark('old') + mark('new')]] as const) {
    const changed = operation === 'update' ? ' WHEN old.channel_id IS NOT new.channel_id OR old.ts IS NOT new.ts OR old.content IS NOT new.content OR old.author_id IS NOT new.author_id OR old.deleted_at IS NOT new.deleted_at OR old.pruned_at IS NOT new.pruned_at' : '';
    reconcileDefinition(db, `${table}/span/${operation}`, `CREATE TRIGGER IF NOT EXISTS "${table}_span_${operation}" AFTER ${operation.toUpperCase()} ON messages${changed} BEGIN ${body} END`);
  }
}
