import { fork } from 'node:child_process';
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { compressRawJson, openDb, rekey, setSetting, type Db } from '../src/core/db';
import { archiveRead, pluginDb, type ArchiveRead, type PluginDb } from '../src/core/plugins/pluginDb';
import { createArchiveRefViews } from '../src/core/plugins/archiveRefs';
import { archiveReadPrivacyChanged, closeArchiveReads } from '../src/core/reads/archiveReads';
import { ArchiveReadPool, ARCHIVE_READ_POOL_SIZE, ARCHIVE_READ_BACKGROUND_QUEUE_MAX } from '../src/core/reads/pool';
import { definePlugin, pluginTable, visibleTable } from '@plugin-sdk/shared';
import { seedArchiveViews } from './archiveViewsFixture';
import { tempDb, tempDir } from './helpers';

const ENTRY = join(import.meta.dirname, '../out/read-tests/archiveReadProcess.js');
const HEAVY = `WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x < 1000000000) SELECT sum(x) FROM n`;
/** Allow helper startup before measuring an abort inside native code. */
const HEAD_START_MS = 300;
/** A frame plus IPC under CI scheduling; measurements below record actual latency. */
const ABORT_BUDGET_MS = 100;
/** A cancelled billion-row scan must release handles without waiting for its natural completion. */
const SHUTDOWN_BUDGET_MS = 2000;
/** Several cancellations catch slot reuse and listener cleanup errors. */
const ABORT_REPETITIONS = 3;
const TIMER_INTERVAL_MS = 5;
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const outcome = <T>(p: Promise<T>): Promise<T | unknown> => p.catch((e: unknown) => e);
let db: Db;
let api: PluginDb;
let readRows: ArchiveRead;
beforeEach(() => { db = tempDb(); seedArchiveViews(db); api = pluginDb(() => db, () => true, 'readprobe'); readRows = archiveRead(() => db); });
afterEach(async () => { await closeArchiveReads(db); if (db.open) db.close(); });

describe('off-thread plugin archive reads', () => {
  it('matches synchronous views, named parameters, compressed payloads and later privacy changes', async () => {
    db.prepare("UPDATE messages SET raw_json = ? WHERE id = 'm-open'").run(compressRawJson('{"flags":8192}'));
    const sql = `SELECT id, text, author_name, raw_json, msg_json(raw_json) AS payload FROM archive_messages WHERE ts >= @since ORDER BY id`;
    for (const privacy of [false, true, false]) {
      setSetting(db, 'privacyMode', privacy);
      expect(await readRows(sql, { since: 0 })).toEqual(api.prepare(sql).all({ since: 0 }));
      const counts = 'SELECT channel_id, count(*) AS count FROM archive_messages GROUP BY channel_id ORDER BY channel_id';
      expect(await readRows(counts)).toEqual(api.prepare(counts).all());
      const search = "SELECT seq FROM archive_search WHERE query MATCH ? ORDER BY seq";
      expect(await readRows(search, ['hello'])).toEqual(api.prepare(search).all('hello'));
    }
  });

  it('sees plugin tables, reference views and committed writes after worker startup', async () => {
    const descriptor = definePlugin({ manifest: { id: 'readprobe', name: 'Read probe', version: '1', description: '' }, archiveRefs: { notes: { channel: 'channel_id' } } });
    const table = pluginTable(descriptor, 'notes');
    db.exec(`CREATE TABLE ${table} (channel_id TEXT, text TEXT); INSERT INTO ${table} VALUES ('c-open', 'open'), ('c-hide', 'hidden')`);
    createArchiveRefViews(db, descriptor);
    setSetting(db, 'privacyMode', true);
    const view = `SELECT * FROM ${visibleTable(descriptor, 'notes')} ORDER BY text`;
    expect(await readRows(view)).toEqual(api.prepare(view).all());
    db.prepare(`INSERT INTO ${table} VALUES (?, ?)`).run('c-open', 'later');
    expect(await readRows(`SELECT * FROM ${table} ORDER BY text`)).toEqual(api.prepare(`SELECT * FROM ${table} ORDER BY text`).all());
  });

  it('enforces read-only statements and connection guards without changing later reads', async () => {
    for (const sql of [
      'DELETE FROM messages RETURNING id', 'CREATE TABLE forbidden (v)', 'UPDATE settings SET value = value',
      'PRAGMA query_only = OFF', "ATTACH ':memory:' AS side", 'BEGIN', 'VACUUM',
      '; /* skip */ EXPLAIN QUERY PLAN PRAGMA writable_schema = ON',
      "SELECT 1; DELETE FROM messages", 'SELECT load_extension(?)',
    ]) await expect(readRows(sql)).rejects.toThrow();
    expect(await readRows('SELECT count(*) AS count FROM archive_messages')).toEqual(api.prepare('SELECT count(*) AS count FROM archive_messages').all());
    let pending!: Promise<unknown[]>;
    db.transaction(() => { pending = readRows('SELECT 1'); })();
    await expect(pending).rejects.toThrow(/uncommitted/);
  });

  it('cancels an older native snapshot when privacy changes and reads the new visibility afterwards', async () => {
    await readRows('SELECT 1');
    const pending = outcome(readRows(HEAVY));
    await delay(HEAD_START_MS);
    setSetting(db, 'privacyMode', true);
    archiveReadPrivacyChanged(db);
    expect(await pending).toMatchObject({ message: 'Archive visibility changed; repeat the lookup' });
    const sql = 'SELECT id FROM archive_messages ORDER BY id';
    expect(await readRows(sql)).toEqual(api.prepare(sql).all());
  });

  it('cancels native work promptly, keeps timers and another reader responsive, and replaces helpers repeatedly', async () => {
    await readRows('SELECT 1');
    for (let i = 0; i < ABORT_REPETITIONS; i++) {
      const control = new AbortController();
      const pending = outcome(readRows(HEAVY, [], { signal: control.signal }));
      let ticks = 0;
      const timer = setInterval(() => ticks++, TIMER_INTERVAL_MS);
      await delay(HEAD_START_MS);
      expect(await readRows('SELECT 42 AS answer')).toEqual([{ answer: 42 }]);
      const start = performance.now();
      control.abort(new Error('Stop lookup'));
      expect(await pending).toBe(control.signal.reason);
      const abortMs = performance.now() - start;
      clearInterval(timer);
      expect(abortMs).toBeLessThan(ABORT_BUDGET_MS);
      expect(ticks).toBeGreaterThan(5);
      console.info('archive read abort', { iteration: i, abortMs, ticks });
      expect(await readRows('SELECT 7 AS answer')).toEqual([{ answer: 7 }]);
    }
    const start = performance.now();
    await closeArchiveReads(db);
    expect(performance.now() - start).toBeLessThan(SHUTDOWN_BUDGET_MS);
  });

  it('bounds queued work and cancels queued/pre-aborted reads without running them', async () => {
    const pool = new ArchiveReadPool({ path: db.name, key: null }, ENTRY);
    const control = new AbortController();
    const jobs = Array.from({ length: ARCHIVE_READ_POOL_SIZE + ARCHIVE_READ_BACKGROUND_QUEUE_MAX }, (_, i) => outcome(pool.read(HEAVY.replace('sum(x)', 'sum(x) + ?'), [i], control.signal)));
    await expect(pool.read('SELECT 1', [])).rejects.toThrow(/queue is full/);
    control.abort(new Error('Cancelled queue'));
    expect((await Promise.all(jobs)).every((r) => r === control.signal.reason)).toBe(true);
    await expect(pool.read('SELECT 1', [], control.signal)).rejects.toBe(control.signal.reason);
    // Both original slots were killed; success requires a fresh helper after their close events.
    expect(await pool.read('SELECT 7 AS answer', [])).toEqual([{ answer: 7 }]);
    const start = performance.now();
    await pool.close();
    expect(performance.now() - start).toBeLessThan(SHUTDOWN_BUDGET_MS);
  });

  it('ends a helper busy in native SQLite when the core IPC pipe closes, releasing the archive file', async () => {
    const path = join(tempDir(), 'orphan.db');
    openDb(path).close();
    const helper = fork(ENTRY, [], { execArgv: [], serialization: 'advanced', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    onTestFinished(() => { if (helper.exitCode === null && helper.signalCode === null) helper.kill('SIGKILL'); });
    const started = new Promise<void>((resolve) => helper.on('message', (m: { kind: string }) => { if (m.kind === 'started') resolve(); }));
    const exited = new Promise<void>((resolve) => helper.once('exit', () => resolve()));
    helper.send({ path, key: null });
    helper.send({ sql: HEAVY, params: [] });
    await started;
    await delay(HEAD_START_MS);
    helper.disconnect();
    const timedOut = await Promise.race([exited.then(() => false), delay(SHUTDOWN_BUDGET_MS).then(() => true)]);
    expect(timedOut).toBe(false);
    expect(() => renameSync(path, `${path}.moved`)).not.toThrow();
  });

  it('opens encrypted archives read-only and refreshes the key after rekey', async () => {
    const path = join(tempDir(), 'encrypted.db');
    const encrypted = openDb(path, 'fixture_key');
    const read = archiveRead(() => encrypted);
    try {
      expect(await read('SELECT count(*) AS count FROM archive_messages')).toEqual([{ count: 0 }]);
      await closeArchiveReads(encrypted);
      rekey(encrypted, 'replacement_key');
      expect(await read('SELECT 9 AS answer')).toEqual([{ answer: 9 }]);
    } finally { await closeArchiveReads(encrypted); encrypted.close(); }
  });

  it('works in the real Electron utility process with a direct native worker and killable readers', async () => {
    const electron = (await import('electron')).default as unknown as string;
    const launcher = join(import.meta.dirname, 'fixtures/archiveReadElectron.cjs');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = fork(launcher, [join(import.meta.dirname, '../out/read-tests/archiveReadProbe.js'), db.name, tempDir()], {
      execPath: electron, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
    });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    onTestFinished(() => { child.kill(); });
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      let errors = '';
      child.stderr!.on('data', (data) => errors += String(data));
      child.on('error', reject);
      child.on('message', (message) => resolve(message as Record<string, unknown>));
      child.on('exit', (code) => reject(new Error(`Electron probe exited ${code}: ${errors}`)));
    });
    expect(result.ok).toBe(true);
    expect(result.aborted).toBe(true);
    expect(result.direct).toEqual(api.prepare('SELECT count(*) AS count FROM archive_messages').all());
    expect(result.unrelated).toEqual([{ answer: 42 }]);
    expect(result.replacement).toEqual([{ answer: 7 }]);
    expect(result.ticks).toBeGreaterThan(5);
    expect(result.abortMs).toBeLessThan(ABORT_BUDGET_MS);
    expect(result.closeMs).toBeLessThan(SHUTDOWN_BUDGET_MS);
    console.info('Electron utility archive read measurement', result);
    child.kill(); // Only this disposable test launcher; the real app is never involved.
    await exited;
  });
});
