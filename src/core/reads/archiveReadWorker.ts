import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3-multiple-ciphers';
import { rawJsonText } from '../rawJson';
import { checkReadStatement, type ReadConnection, type ReadQuery, type ReadReply } from './protocol';

const { path, key } = workerData as ReadConnection;
let db: Database.Database | undefined;

/** One connection per helper: opening per read costs ~8 ms plaintext, more with a key. The core kills helpers before closing, moving or rekeying the archive. */
function connection(): Database.Database {
  if (db) return db;
  const opened = new Database(path, { readonly: true, fileMustExist: true });
  try {
    if (key !== null) {
      if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error('Archive key has an unexpected format.');
      opened.pragma(`key = '${key}'`);
    }
    opened.function('msg_json', { deterministic: true }, (v: unknown) => rawJsonText(v as string | Buffer | null));
    // Persistent views and plugin tables are shared; the host installs no authorizer or attached databases.
    opened.pragma('query_only = ON');
  } catch (error) {
    opened.close();
    throw error;
  }
  return (db = opened);
}

parentPort!.on('message', ({ sql, params }: ReadQuery) => {
  let reply: ReadReply;
  try {
    checkReadStatement(sql);
    const stmt = connection().prepare(sql);
    if (!stmt.readonly || !stmt.reader) throw new Error('Archive reads require a read-only row statement');
    parentPort!.postMessage({ kind: 'started' } satisfies ReadReply);
    const rows = Array.isArray(params) ? stmt.all(...params) : stmt.all(params);
    reply = { kind: 'rows', rows };
  } catch (error) {
    const e = error as Error & { code?: string };
    reply = { kind: 'error', message: e.message, code: e.code };
  }
  parentPort!.postMessage(reply);
});
