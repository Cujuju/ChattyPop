import type { Db } from '../db';
import { readArchive } from '../reads/archiveReads';
import { MS_PER_S } from '@shared/units';

const SPAN_INPUT_BATCH = 32; // Limit overlap-result application to a small set of changed days per writer turn.
const SPAN_APPLY_BATCH = 128; // Even a day with many historical runs must yield during dirty-row application.
export const SPAN_PENDING_LAST_DAY = '9999-12-31'; // An unexpanded input temporarily gates its channel's stored openers.

export function installSpanInputs(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS rollup_span_inputs (
    rollup TEXT NOT NULL, channel_id TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY(rollup, channel_id, day))`);
}

interface Input { channel_id: string; day: string; revision: number }
interface Overlap { channel_id: string; first_day: string; last_day: string }

/** Queued days cover all later arrivals that day. A rollup drains its inputs before starting any compute. */
export async function seedSpanInputs(db: Db, id: string, table: string,
  span: { start: string; end: string; paddingMs: number }, signal: AbortSignal): Promise<boolean> {
  const pending = db.prepare(`SELECT i.channel_id, i.day, g.revision FROM rollup_span_inputs i
    JOIN rollup_span_generations g USING(rollup, channel_id) WHERE i.rollup = ? LIMIT ?`);
  while (true) {
    const inputs = pending.all(id, SPAN_INPUT_BATCH) as Input[];
    if (!inputs.length) return true;
    const rows = await readArchive<Overlap>(db, `SELECT DISTINCT r.channel_id,
      date(r."${span.start}" / ${MS_PER_S}, 'unixepoch') AS first_day,
      date(r."${span.end}" / ${MS_PER_S}, 'unixepoch') AS last_day
      FROM json_each(@inputs) i CROSS JOIN "${table}" r INDEXED BY "${table}_span"
      WHERE r.channel_id = json_extract(i.value, '$.channel_id')
        AND r."${span.end}" >= unixepoch(json_extract(i.value, '$.day')) * ${MS_PER_S} - @padding
        AND r."${span.start}" < unixepoch(json_extract(i.value, '$.day'), '+1 day') * ${MS_PER_S} + @padding`,
    { inputs: JSON.stringify(inputs), padding: span.paddingMs }, signal, 'background');
    signal.throwIfAborted();
    const generation = db.prepare('SELECT revision FROM rollup_span_generations WHERE rollup = ? AND channel_id = ?').pluck();
    const stable = new Set(inputs.filter((input) => generation.get(id, input.channel_id) === input.revision).map((input) => input.channel_id));
    if (!stable.size) return false;
    const mark = db.prepare(`INSERT INTO rollup_span_dirty(rollup, channel_id, first_day, last_day) VALUES (?, ?, ?, ?)
      ON CONFLICT(rollup, channel_id, first_day, last_day) DO UPDATE SET revision = revision + 1`);
    const remove = db.prepare('DELETE FROM rollup_span_inputs WHERE rollup = ? AND channel_id = ? AND day = ?');
    const refreshStable = () => {
      for (const input of inputs) if (generation.get(id, input.channel_id) !== input.revision) stable.delete(input.channel_id);
    };
    for (let offset = 0; offset < rows.length; offset += SPAN_APPLY_BATCH) {
      refreshStable();
      db.transaction(() => {
        for (const row of rows.slice(offset, offset + SPAN_APPLY_BATCH)) if (stable.has(row.channel_id)) mark.run(id, row.channel_id, row.first_day, row.last_day);
      })();
      await new Promise<void>((resolve) => setImmediate(resolve));
      signal.throwIfAborted();
    }
    refreshStable();
    if (!stable.size) return false;
    db.transaction(() => {
      for (const input of inputs) if (stable.has(input.channel_id)) remove.run(id, input.channel_id, input.day);
      for (const channel of stable) db.prepare(`DELETE FROM rollup_span_dirty WHERE rollup = ? AND channel_id = ?
        AND first_day = '' AND last_day = ? AND NOT EXISTS (
          SELECT 1 FROM rollup_span_inputs WHERE rollup = ? AND channel_id = ?)`)
        .run(id, channel, SPAN_PENDING_LAST_DAY, id, channel);
    })();
    await new Promise<void>((resolve) => setImmediate(resolve));
    signal.throwIfAborted();
  }
}
