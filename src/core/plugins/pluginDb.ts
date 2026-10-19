// Activation-scoped database writes throw after unload; reads remain available. Wrappers expose neither raw connections nor connection-changing statements.
import type Database from 'better-sqlite3-multiple-ciphers';
import { PluginInactiveError } from '@shared/pluginCall';
import type { Db } from '../db';
import { computeArchive, readArchive } from '../reads/archiveReads';
import type { ReadPriority } from '@shared/readPriority';
import { checkSyncRead, pluginCalls } from './callContext';
import { checkReadStatement } from '../reads/protocol';

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

/** Off-thread read-only rows from committed archive data. Abort stops native work and rejects with the signal's reason. */
export interface ArchiveReadOptions {
  signal?: AbortSignal;
  priority?: ReadPriority;
  /** Closure-free rollup-compatible function, run in one worker snapshot; returns rows directly to the caller. */
  fold?: { source: string; data: unknown };
}
export type ArchiveRead = <R = unknown>(source: string, params?: readonly unknown[] | Record<string, unknown>, options?: ArchiveReadOptions) => Promise<R[]>;

/** `ctx.storage.read` over `db` (read at each use: the archive can move). Separate from PluginDb, which a raw connection satisfies. */
export function archiveRead(db: () => Db): ArchiveRead {
  return async <R,>(source: string, params: readonly unknown[] | Record<string, unknown> = [], options: ArchiveReadOptions = {}): Promise<R[]> => {
    const call = pluginCalls.getStore();
    const signal = call ? (options.signal ? AbortSignal.any([call.signal, options.signal]) : call.signal) : options.signal;
    signal?.throwIfAborted();
    checkReadStatement(source);
    if (options.fold) {
      const [result] = await computeArchive<{ rows: R[] }>(db(), { ...options.fold, partition: null }, signal,
        options.priority ?? call?.priority ?? 'background');
      return result!.rows;
    }
    return readArchive<R>(db(), source, params, signal, options.priority ?? call?.priority ?? 'background');
  };
}

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
      checkReadStatement(source);
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
  const check = stmt.readonly ? checkSyncRead : fence;
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
      return fencedIterator(stmt.iterate(...params), check);
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
