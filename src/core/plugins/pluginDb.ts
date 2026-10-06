// Activation-scoped database writes throw after unload; reads remain available. Wrappers expose neither raw connections nor connection-changing statements.
import type Database from 'better-sqlite3-multiple-ciphers';
import { PluginInactiveError } from '@shared/pluginCall';
import type { Db } from '../db';

type RawStatement = Database.Statement<unknown[], unknown>;

/** A statement from PluginDb.prepare: better-sqlite3's, without the way back to the unfenced database. */
export interface PluginStatement<P extends unknown[] = unknown[], R = unknown> {
  readonly source: string;
  /** It returns rows. */
  readonly reader: boolean;
  /** It never writes, so it keeps working after the lifetime ends. */
  readonly readonly: boolean;
  run(...params: P): Database.RunResult;
  get(...params: P): R | undefined;
  all(...params: P): R[];
  iterate(...params: P): IterableIterator<R>;
  pluck(toggleState?: boolean): this;
  expand(toggleState?: boolean): this;
  raw(toggleState?: boolean): this;
}

/** What better-sqlite3 accepts as a transaction's body. */
type TransactionBody = Parameters<Database.Database['transaction']>[0];
type TransactionArgs<F extends TransactionBody> = Parameters<Database.Transaction<F>>;

/** A function running `fn` in one transaction, as better-sqlite3's but without its `database`. */
export type PluginTransaction<F extends TransactionBody> = ((...params: TransactionArgs<F>) => ReturnType<F>) & {
  deferred(...params: TransactionArgs<F>): ReturnType<F>;
  immediate(...params: TransactionArgs<F>): ReturnType<F>;
  exclusive(...params: TransactionArgs<F>): ReturnType<F>;
};

/** A plugin's database: the archive's statement surface, writes fenced by a lifetime. */
export interface PluginDb {
  /** The archive is open (it closes while it moves). */
  readonly open: boolean;
  /**
   * Throws for a statement that changes the shared connection (PRAGMA, ATTACH, transaction control, VACUUM), EXPLAINed or
   * not: plugins share the host's connection, and some act while being prepared.
   */
  prepare<P extends unknown[] | {} = unknown[], R = unknown>(source: string): P extends unknown[] ? PluginStatement<P, R> : PluginStatement<[P], R>;
  /** `fn` in one transaction; statements `fn` runs keep their own write fence. */
  transaction<F extends TransactionBody>(fn: F): PluginTransaction<F>;
}

/** Whitespace, SQL comments and empty statements (`;`), which SQLite skips before a statement's first keyword. */
const TRIVIA = String.raw`(?:\s|--[^\n]*(?:\n|$)|/\*[\s\S]*?(?:\*/|$)|;)*`;
/** Statements that change the connection the host and every plugin share, rather than rows; plugins use `transaction`. */
const CONNECTION_KEYWORDS = ['pragma', 'attach', 'detach', 'begin', 'commit', 'end', 'rollback', 'savepoint', 'release', 'vacuum'];
/** A connection statement, alone or under EXPLAIN [QUERY PLAN] (SQLite's only statement prefix). */
const CONNECTION_STATEMENT = new RegExp(
  String.raw`^${TRIVIA}(?:explain\b${TRIVIA}(?:query\b${TRIVIA}plan\b${TRIVIA})?)?(?:${CONNECTION_KEYWORDS.join('|')})\b`,
  'i',
);

/**
 * `db` (read at each use: the archive can move) for plugin `pluginId`: statements that write throw PluginInactiveError
 * once `writable` is false.
 */
export function pluginDb(db: () => Db, writable: () => boolean, pluginId: string): PluginDb {
  const fence = (): void => {
    if (!writable()) throw new PluginInactiveError(pluginId);
  };
  const facade: PluginDb = {
    get open() {
      return db().open;
    },
    prepare: (source) => {
      if (CONNECTION_STATEMENT.test(source)) throw new Error(`${pluginId} may not run statements that change the shared connection`);
      return fencedStatement(db().prepare(source), fence) as never;
    },
    transaction: (fn) => {
      type Args = TransactionArgs<typeof fn>;
      // `fn` runs with its caller's `this`, never the native transaction's (whose `database` is the raw connection).
      type Result = ReturnType<typeof fn>;
      const tx = db().transaction((self: unknown, ...params: Args): Result => fn.apply(self, params) as Result);
      const bare = (run: (self: unknown, ...params: Args) => Result) =>
        function (this: unknown, ...params: Args): Result {
          return run(this, ...params);
        };
      return Object.assign(bare(tx), { deferred: bare(tx.deferred), immediate: bare(tx.immediate), exclusive: bare(tx.exclusive) });
    },
  };
  return facade;
}

/** `it` with `check` run before each step: a writing statement (INSERT … RETURNING) writes as it advances. */
function fencedIterator<R>(it: IterableIterator<R>, check: () => void): IterableIterator<R> {
  const fenced: IterableIterator<R> = {
    next: () => {
      try {
        check();
      } catch (err) {
        it.return?.(); // an open iterator keeps the shared connection busy
        throw err;
      }
      return it.next();
    },
    return: (value?: unknown) => it.return?.(value) ?? { done: true, value: undefined as never },
    [Symbol.iterator]: () => fenced,
  };
  return fenced;
}

/** Fences writing statement runs. Modifiers return wrappers and retain better-sqlite3’s bare-call behavior. */
function fencedStatement(stmt: RawStatement, fence: () => void): PluginStatement {
  const check = stmt.readonly ? (): void => undefined : fence;
  const wrapper: PluginStatement = {
    source: stmt.source,
    reader: stmt.reader,
    readonly: stmt.readonly,
    run: (...params) => {
      check();
      return stmt.run(...params);
    },
    get: (...params) => {
      check();
      return stmt.get(...params);
    },
    all: (...params) => {
      check();
      return stmt.all(...params);
    },
    iterate: (...params) => {
      check();
      return stmt.readonly ? stmt.iterate(...params) : fencedIterator(stmt.iterate(...params), check);
    },
    pluck: (toggleState) => {
      stmt.pluck(toggleState ?? true);
      return wrapper;
    },
    expand: (toggleState) => {
      stmt.expand(toggleState ?? true);
      return wrapper;
    },
    raw: (toggleState) => {
      stmt.raw(toggleState ?? true);
      return wrapper;
    },
  };
  return wrapper;
}
