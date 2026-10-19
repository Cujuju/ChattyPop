// Runs in a disposable Electron utility process; never loads the app or its profile.
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { archiveRead, type ArchiveRead } from '../src/core/plugins/pluginDb';
import { closeArchiveReads, computeArchive, configureArchiveReads } from '../src/core/reads/archiveReads';
import type { ReadReply } from '../src/core/reads/protocol';
import { ARCHIVE_READ_POOL_SIZE } from '../src/core/reads/pool';

/** Long native aggregation, independent of fixture size; aborted before completing. */
const HEAVY = `WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x < 1000000000) SELECT sum(x) AS total FROM n`;
/** Let the helper enter sqlite3_step before cancellation. */
const QUERY_HEAD_START_MS = 300;
const TIMER_INTERVAL_MS = 5;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

process.parentPort.on('message', async ({ data }: { data: { path: string } }) => {
  const db = new Database(data.path, { readonly: true, fileMustExist: true });
  configureArchiveReads(db, null);
  const read = archiveRead(() => db);
  try {
    // Direct worker in utilityProcess proves the native module also works without the killable process wrapper.
    const worker = new Worker(join(import.meta.dirname, 'archiveReadWorker.js'), { workerData: { path: data.path, key: null } });
    const direct = await new Promise<unknown[]>((resolve, reject) => {
      worker.on('error', reject);
      worker.on('message', (reply: ReadReply) => {
        if (reply.kind === 'rows') resolve(reply.rows);
        if (reply.kind === 'error') reject(new Error(reply.message));
      });
      worker.postMessage({ sql: 'SELECT count(*) AS count FROM archive_messages', params: [] });
    });
    await worker.terminate();
    await Promise.all(Array.from({ length: ARCHIVE_READ_POOL_SIZE }, () => read('SELECT 1')));
    const compute = async (_part: unknown, read: ArchiveRead) => {
      if ('rollupProbeCore' in globalThis) throw new Error('Rollup compute ran on Core');
      return read('SELECT count(*) AS count FROM archive_messages');
    };
    (globalThis as Record<string, unknown>).rollupProbeCore = true;
    let rollup: { rows: unknown[]; watermark: number } | undefined;
    try {
      [rollup] = await computeArchive<{ rows: unknown[]; watermark: number }>(db,
        { source: compute.toString(), partition: {}, data: undefined }, new AbortController().signal);
    } finally { delete (globalThis as Record<string, unknown>).rollupProbeCore; }
    if (JSON.stringify(rollup?.rows) !== JSON.stringify(direct)) throw new Error('Rollup worker returned different archive rows');
    const control = new AbortController();
    let ticks = 0;
    const timer = setInterval(() => ticks++, TIMER_INTERVAL_MS);
    const pending = read(HEAVY, [], { signal: control.signal }).catch((error: unknown) => error);
    await delay(QUERY_HEAD_START_MS);
    const unrelatedStart = performance.now();
    const unrelated = await read('SELECT 42 AS answer');
    const unrelatedMs = performance.now() - unrelatedStart;
    const start = performance.now();
    control.abort(new Error('Stopped'));
    const error = await pending;
    const abortMs = performance.now() - start;
    clearInterval(timer);
    const replacement = await read('SELECT 7 AS answer');
    const closeStart = performance.now();
    await closeArchiveReads(db);
    const closeMs = performance.now() - closeStart;
    process.parentPort.postMessage({ ok: true, direct, rollup, unrelated, replacement, ticks, abortMs, unrelatedMs, closeMs, aborted: error === control.signal.reason });
  } catch (error) {
    process.parentPort.postMessage({ ok: false, error: String(error) });
  } finally {
    await closeArchiveReads(db);
    db.close();
    setImmediate(() => process.exit());
  }
});
