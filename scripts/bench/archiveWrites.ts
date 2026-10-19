import { testPlugin } from '@plugin-sdk/core/testing';
import { attachments, links, stats, seed, CHANNEL } from 'write-bench-plugins';
import { textedLinkCount } from '@core/queries/messageText';
import { ArchiveMessages } from '@core/archiveMessages';
import { ARRIVAL } from '@core/arrival';
import { snowflakeFromMs, type RawMessage } from '@shared/discord';
import { openDb } from '@core/db';

const RUNS = 3; // Three samples match the original stall-attribution measurement.
const MESSAGES = 20_000; // Original mixed-write fixture: 8k files and 3.2k shares.
const REFETCH_MESSAGES = 1_000; // A catch-up page large enough to expose repeated preparation.
const START = Date.UTC(2026, 0, 1);
const MICROSECONDS_PER_MILLISECOND = 1_000; // Node reports process CPU time in microseconds.
const FAMILIES = ['partition', 'reference', 'span', 'metadata'] as const;
type Family = typeof FAMILIES[number];
const family = (name: string): Family | undefined => name.includes('_span_') ? 'span'
  : name.startsWith('rollup_reference_') ? 'reference' : name.startsWith('rollup_metadata_') ? 'metadata'
  : /^rollup_(messages|attachments|links)_/.test(name) ? 'partition' : undefined;
const yieldTurn = () => new Promise<void>((done) => setImmediate(done));

/** The writer runs synchronously on Core; its uninterrupted operation is the blocking turn. */
function turn(fn: () => unknown) {
  const cpu = process.cpuUsage();
  const start = performance.now(); fn();
  const ms = performance.now() - start;
  const used = process.cpuUsage(cpu);
  return { ms, longestBlockingTurnMs: ms, cpuMs: (used.user + used.system) / MICROSECONDS_PER_MILLISECOND };
}

export async function main() {
  const samples: { run: number; mode: string; ms: number; cpuMs: number; sqliteChanges: number; longestBlockingTurnMs: number; triggers: number }[] = [];
  for (let run = 0; run < RUNS; run++) for (const mode of ['none', ...FAMILIES, 'all']) {
    const t = testPlugin(attachments, { with: [links, stats], archive: { channels: [{ id: CHANNEL }] } });
    const db = openDb(t.db.prepare("SELECT file FROM pragma_database_list WHERE name = 'main'").pluck().get() as string);
    try {
      const triggers = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger'").all() as { name: string }[];
      const rollupTriggers = triggers.filter(({ name }) => name.startsWith('rollup_') || name.includes('_span_'));
      for (const { name } of rollupTriggers) if (mode !== 'all' && (mode === 'none' || family(name) !== mode)) {
        db.prepare(`DROP TRIGGER "${name.replaceAll('"', '""')}"`).run();
      }
      let counts: object = {};
      const changed = () => db.prepare('SELECT total_changes()').pluck().get() as number;
      const before = changed();
      const timing = turn(() => { counts = seed(db, MESSAGES); });
      const sample = { run, mode, triggers: rollupTriggers.length, sqliteChanges: changed() - before, ...counts, ...timing };
      samples.push(sample); console.log(JSON.stringify({ benchmark: 'trigger-family', ...sample }));
    } finally { db.close(); await t.dispose(); }
    await yieldTurn();
  }
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  console.log(JSON.stringify({ benchmark: 'mixed-write-summary', modes: ['none', ...FAMILIES, 'all'].map((mode) => {
    const rows = samples.filter((row) => row.mode === mode);
    return { mode, medianMs: median(rows.map((row) => row.ms)), medianCpuMs: median(rows.map((row) => row.cpuMs)),
      sqliteChanges: rows[0]!.sqliteChanges, longestBlockingTurnMs: Math.max(...rows.map((row) => row.longestBlockingTurnMs)) };
  }) }));
  for (let run = 0; run < RUNS; run++) {
    const t = testPlugin(attachments, { archive: { channels: [{ id: CHANNEL }] } });
    const db = openDb(t.db.prepare("SELECT file FROM pragma_database_list WHERE name = 'main'").pluck().get() as string);
    try {
      const messages: RawMessage[] = Array.from({ length: REFETCH_MESSAGES }, (_, n) => ({
        id: snowflakeFromMs(START + n), channel_id: CHANNEL, author: { id: 'author', username: 'Author' },
        content: `https://example.test/${n}`, timestamp: new Date(START + n).toISOString(), edited_timestamp: null,
        attachments: [], embeds: [{ url: `https://example.test/${n}`, title: 'Preview text' }],
      }));
      const archive = new ArchiveMessages(db, () => true, () => {}, () => {}, () => {}, () => {});
      archive.ingestMessages(messages, ARRIVAL.sync);
      let prepareMs = 0, executionMs = 0, prepares = 0, executions = 0;
      const prepare = db.prepare.bind(db);
      db.prepare = ((sql: string) => {
        const tracked = sql.startsWith('SELECT COUNT(text)');
        const start = performance.now(), statement = prepare(sql);
        if (!tracked) return statement;
        prepares++; prepareMs += performance.now() - start;
        const get = statement.get.bind(statement);
        statement.get = ((...args: unknown[]) => {
          const start = performance.now();
          try { return get(...args); } finally { executions++; executionMs += performance.now() - start; }
        }) as typeof statement.get;
        return statement;
      }) as typeof db.prepare;
      const timing = turn(() => archive.ingestMessages(messages, ARRIVAL.sync));
      console.log(JSON.stringify({ benchmark: 'unchanged-refetch', run, messages: messages.length, ...timing, prepares, executions, prepareMs, executionMs }));
      db.prepare = prepare;
      const count = textedLinkCount(db, messages[0]!.id);
      if (count !== 1) throw new Error(`Expected linked text, got ${count}`);
    } finally { db.close(); await t.dispose(); }
  }
}
