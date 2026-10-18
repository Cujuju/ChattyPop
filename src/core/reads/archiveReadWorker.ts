import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3-multiple-ciphers';
import { rawJsonText } from '../rawJson';
import { checkReadStatement, type ReadConnection, type ReadQuery, type ReadReply } from './protocol';

const { path, key } = workerData as ReadConnection;
parentPort!.on('message', ({ sql, params }: ReadQuery) => {
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
    const stmt = db.prepare(sql);
    if (!stmt.readonly || !stmt.reader) throw new Error('Archive reads require a read-only row statement');
    parentPort!.postMessage({ kind: 'started' } satisfies ReadReply);
    const rows = Array.isArray(params) ? stmt.all(...params) : stmt.all(params);
    reply = { kind: 'rows', rows };
  } catch (error) {
    const e = error as Error & { code?: string };
    reply = { kind: 'error', message: e.message, code: e.code };
  } finally {
    db?.close();
  }
  parentPort!.postMessage(reply);
});
