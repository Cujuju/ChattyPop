import { testPlugin } from '@plugin-sdk/core/testing';
import { attachments, links, stats, CHANNEL } from 'write-bench-plugins';
import { Archive } from '@core/archive';
import { ARRIVAL } from '@core/arrival';
import { openDb } from '@core/db';
import { snowflakeFromMs, type RawMessage } from '@shared/discord';
import { MS_PER_DAY, MS_PER_S } from '@shared/units';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const HISTORY = 400_000; // Matches the Analytics real-scale fixture without accessing a profile.
const BULK = 20_000; // Matches the reopened issue's backfill size.
const PAGE = 100; // Discord history page size.
const RUNS = 3; // Report medians and retain outliers.
const START = Date.UTC(2025, 0, 1);
const DAYS = 390; // Stored history includes more than a year of run overlaps.
const AUTHORS = 30; // Small-community cardinality used by the existing writer fixture.
const HISTORY_STEP = Math.floor(DAYS * MS_PER_DAY / HISTORY); // Distribute the scale fixture across the stored run history.
const CPU_US_PER_MS = 1_000; // Node process CPU measurements are microseconds.
const FILE_PERIOD = 5; // Two of five arrivals carry attachments, matching the mixed writer fixture.
const FILE_MESSAGES = 2;
const LINK_VARIANTS = 4_000; // Repeated URLs exercise shared-link partition notifications.
const FILE_BYTES = 8_192; // Fixed synthetic attachment size, without any real files.
const SNOWFLAKE_STEP = 4_194_304; // Discord reserves the lower 22 bits for worker/sequence fields.
const SQL_SAMPLES = 5; // Retain the dominant execution queries without flooding the result file.
const TEMP_PREFIX = 'cp-ingest-turns-'; // Cleanup is restricted to this benchmark's disposable namespace.

function messages(count: number, offset = HISTORY): RawMessage[] {
  return Array.from({ length: count }, (_, n) => {
    const ts = START + (offset + n) * HISTORY_STEP + 1;
    return { id: snowflakeFromMs(ts), channel_id: CHANNEL, author: { id: `author-${n % AUTHORS}`, username: 'Author' },
      content: n % FILE_PERIOD ? 'Synthetic message with ordinary text.' : `https://example.test/item/${n % LINK_VARIANTS}`,
      timestamp: new Date(ts).toISOString(), edited_timestamp: null,
      attachments: n % FILE_PERIOD < FILE_MESSAGES ? [{ id: snowflakeFromMs(ts), filename: 'fixture.png', url: 'https://example.test/fixture.png', size: FILE_BYTES }] : [],
      embeds: n % FILE_PERIOD ? [] : [{ url: `https://example.test/item/${n % LINK_VARIANTS}`, title: 'Preview text' }],
    };
  });
}

export async function main() {
  const t = testPlugin(attachments, { with: [links, stats], archive: { channels: [{ id: CHANNEL }] } });
  const source = t.db.prepare("SELECT file FROM pragma_database_list WHERE name = 'main'").pluck().get() as string;
  const tempRoot = resolve(tmpdir());
  const dir = mkdtempSync(join(tempRoot, TEMP_PREFIX));
  const path = join(dir, 'archive.db');
  const original = openDb(source);
  original.pragma('wal_checkpoint(TRUNCATE)'); original.close();
  copyFileSync(source, path);
  await t.dispose();
  const db = openDb(path);
  try {
    // Isolate the writer from scheduled plugin drains while retaining their real schema and triggers.
    const definitions = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger'").all() as { name: string; sql: string }[];
    for (const { name } of definitions) db.exec(`DROP TRIGGER "${name}"`);
    db.prepare(`WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i + 1 FROM n WHERE i < @rows - 1)
      INSERT INTO messages(id, channel_id, author_id, ts, content)
      SELECT CAST(CAST(@id AS INTEGER) + i * CAST(@step AS INTEGER) * ${SNOWFLAKE_STEP} AS TEXT), @channel, 'author-' || i % @authors,
        @start + i * @step, 'Stored synthetic history.' FROM n`)
      .run({ rows: HISTORY, id: snowflakeFromMs(START), channel: CHANNEL, authors: AUTHORS, start: START, step: HISTORY_STEP });
    const span = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name GLOB 'p_stats_rollup_*' AND sql LIKE '%first_ts%' AND sql LIKE '%last_ts%' AND name NOT LIKE '%all_time%'").pluck().get() as string | undefined;
    if (span) {
      const columns = db.prepare('SELECT name, type FROM pragma_table_info(?)').all(span) as { name: string; type: string }[];
      const insert = db.prepare(`INSERT INTO "${span}" (${columns.map((c) => `"${c.name}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
      db.transaction(() => {
        for (let day = 0; day < DAYS; day++) insert.run(...columns.map(({ name, type }) => name === 'channel_id' ? CHANNEL : name === 'day' ? new Date(START + day * MS_PER_DAY).toISOString().slice(0, 10)
          : name === 'first_ts' ? START + day * MS_PER_DAY : name === 'last_ts' ? START + (day + 1) * MS_PER_DAY - MS_PER_S : type === 'TEXT' ? `run-${day}` : 1));
      })();
    }
    for (const { sql } of definitions) db.exec(sql);
    const archive = new Archive(db);
    console.log(JSON.stringify({ benchmark: 'fixture', history: HISTORY, storedSpanDays: span ? DAYS : 0, triggers: definitions.length }));
    for (const kind of ['live-new', 'live-refetch', 'backfill'] as const) for (let run = 0; run < RUNS; run++) {
      const input = kind === 'backfill' ? messages(BULK, HISTORY / 2 + run * BULK) : messages(PAGE, HISTORY + run * PAGE);
      let longest = 0, segment = performance.now(), turns = 0;
      const account = () => { const now = performance.now(); longest = Math.max(longest, now - segment); segment = now; turns++; };
      const heartbeat = setInterval(account, 0);
      const sql = new Map<string, number>();
      const prepare = db.prepare.bind(db);
      db.prepare = ((query: string) => {
        const statement = prepare(query);
        for (const method of ['get', 'all', 'run'] as const) {
          const original = statement[method].bind(statement);
          statement[method] = ((...args: unknown[]) => { const start = performance.now(); try { return original(...args); }
            finally { sql.set(query, (sql.get(query) ?? 0) + performance.now() - start); } }) as never;
        }
        return statement;
      }) as typeof db.prepare;
      const cpu = process.cpuUsage(), start = performance.now();
      const methods = archive as Partial<Pick<Archive, 'ingestMessagesBatched' | 'ingestSyncPageBatched'>>;
      if (kind === 'backfill') {
        if (methods.ingestMessagesBatched) await methods.ingestMessagesBatched(input, ARRIVAL.sync);
        else archive.ingestMessages(input, ARRIVAL.sync);
      } else if (methods.ingestSyncPageBatched) await methods.ingestSyncPageBatched(CHANNEL, input, 'newer', false, () => null);
      else archive.ingestSyncPage(CHANNEL, input, 'newer', false, null);
      account(); clearInterval(heartbeat); db.prepare = prepare;
      const used = process.cpuUsage(cpu);
      console.log(JSON.stringify({ benchmark: kind, run, messages: input.length, ms: performance.now() - start,
        longestBlockingTurnMs: longest, turns, cpuMs: (used.user + used.system) / CPU_US_PER_MS,
        topSql: [...sql].sort((a, b) => b[1] - a[1]).slice(0, SQL_SAMPLES) }));
      await new Promise<void>((done) => setImmediate(done));
    }
  } finally {
    db.close();
    if (dirname(dir) !== tempRoot || !basename(dir).startsWith(TEMP_PREFIX)) throw new Error('Unexpected benchmark cleanup directory');
    rmSync(dir, { recursive: true, force: true });
  }
}
