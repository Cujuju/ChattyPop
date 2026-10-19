import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3-multiple-ciphers';
import { rawJsonText } from '../rawJson';
import { checkReadStatement, type ReadConnection, type ReadQuery, type ReadReply } from './protocol';
import { foldRollup } from './rollupFold';
import { directory } from '../queries/directory';
import { unjudged } from '../conversations/unjudged';
import { messageSnapshotByIds } from '../queries/messages';
import { archivePayloads } from '../plugins/archivePayloads';
import { messageParts } from '../messageParts';
import { partTexts } from '../derivedText';

const { path, key } = workerData as ReadConnection;
parentPort!.on('message', async ({ sql, params, compute, host }: ReadQuery) => {
  let db: Database.Database | undefined;
  let reply: ReadReply;
  try {
    checkReadStatement(sql);
    // Idle helpers retain no file handles or WAL readers across archive close/reopen.
    db = new Database(path, { readonly: true, fileMustExist: true });
    if (key !== null) {
      if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error('Archive key has an unexpected format.');
      db.pragma(`key = '${key}'`);
    }
    db.function('msg_json', { deterministic: true }, (v: unknown) => rawJsonText(v as string | Buffer | null));
    // Persistent views and plugin tables are shared; the host installs no authorizer or attached databases.
    db.pragma('query_only = ON');
    parentPort!.postMessage({ kind: 'started' } satisfies ReadReply);
    const read = async (source: string, values: ReadQuery['params'] = []): Promise<unknown[]> => {
      checkReadStatement(source);
      const stmt = db!.prepare(source);
      if (!stmt.readonly || !stmt.reader) throw new Error('Archive reads require a read-only row statement');
      return Array.isArray(values) ? stmt.all(...values) : stmt.all(values);
    };
    let rows: unknown[];
    if (host) {
      db.exec('BEGIN');
      switch (host.kind) {
        case 'directory': rows = directory(db, host.unseen, host.self, host.reader, host.notable); break;
        case 'unjudged': rows = unjudged(db, host.now, host.limit); break;
        case 'messages': rows = [messageSnapshotByIds(db, host.ids)]; break;
        case 'payloads': rows = [...archivePayloads(db, host.ids)]; break;
        case 'parts': rows = [{ parts: [...messageParts(db, host.ids)], texts: partTexts(db, host.ids) }]; break;
      }
      db.exec('COMMIT');
    } else if (compute) {
      db.exec('BEGIN');
      const { seq } = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM messages').get() as { seq: number };
      // Functions are closure-free; explicit data carries table names and configuration across the worker boundary.
      const fn = new Function(`"use strict"; return (${compute.source});`)() as (...args: unknown[]) => Promise<unknown[]>;
      const result = await fn(compute.partition, read, new AbortController().signal, compute.data);
      if (!Array.isArray(result)) throw new Error('Rollup compute must return row arrays');
      const fold = compute.fold ? foldRollup(db, compute.fold, compute.partition as { channelId: string; day: string }, result as Record<string, unknown>[]) : undefined;
      rows = [{ rows: result, watermark: seq, fold }];
      db.exec('COMMIT');
    } else rows = await read(sql, params);
    reply = { kind: 'rows', rows };
  } catch (error) {
    const e = error as Error & { code?: string };
    reply = { kind: 'error', message: e.message, code: e.code };
  } finally {
    db?.close();
  }
  parentPort!.postMessage(reply);
});
