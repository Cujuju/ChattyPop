import type { Db } from './db';
import type { Statement } from 'better-sqlite3-multiple-ciphers';

const connections = new WeakMap<Db, Map<string, Statement<unknown[]>>>();

/** Reuse native writer bytecode, including compiled trigger bodies; statements still see the current transaction. */
export function writeStatement(db: Db, sql: string): Statement<unknown[]> {
  let statements = connections.get(db);
  if (!statements) { statements = new Map(); connections.set(db, statements); }
  let statement = statements.get(sql);
  if (!statement) { statement = db.prepare(sql); statements.set(sql, statement); }
  return statement;
}
