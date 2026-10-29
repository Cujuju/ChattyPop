import { existsSync, statSync } from 'node:fs';
import Database from 'better-sqlite3-multiple-ciphers';
import type { ArchiveEncryption } from '@shared/contract';
import { dropArchiveViews, installArchiveViews } from './archiveViews';
import { MIGRATIONS, applyMigration, type Migration } from './migrations';
import { rawJsonText } from './rawJson';
import { configureArchiveReads } from './reads/archiveReads';

export type Db = Database.Database;
export { readStatus } from './archiveStatus';

/** PRAGMA auto_vacuum value for INCREMENTAL. */
const AUTO_VACUUM_INCREMENTAL = 2;

export { compressRawJson, rawJsonText } from './rawJson';

/** A stored payload parsed; null when there is none or it is damaged. */
export const parseRawJson = <T>(v: string | Buffer | null): T | null => {
  const text = rawJsonText(v);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

/** A nullable JSON column parsed; empty reads as null, and so does a value guard rejects. */
export function fromJson<T>(json: string | null, guard?: (v: unknown) => v is T): T | null {
  if (!json) return null;
  const v: unknown = JSON.parse(json);
  return !guard || guard(v) ? (v as T) : null;
}

/** A value as a nullable JSON column: null and undefined are stored as NULL. */
export const toJson = (v: unknown): string | null => (v === null || v === undefined ? null : JSON.stringify(v));

/** Rewrites the database without free space, then shrinks the WAL the rewrite passed through. */
export function compact(db: Db): void {
  db.exec('VACUUM');
  db.pragma('wal_checkpoint(TRUNCATE)');
}

/** Settings values are JSON-encoded; unknown keys read as undefined. */
export function getSetting(db: Db, key: string): unknown {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row === undefined ? undefined : JSON.parse(row.value);
}

/**
 * Whether the work version stamped at `key` is at least `version`. Builds share a profile, so a newer build's higher stamp
 * means the work is done; an older build must neither redo it nor lower the stamp.
 */
export function stampedAtLeast(db: Db, key: string, version: number): boolean {
  const stored = getSetting(db, key);
  return typeof stored === 'number' && stored >= version;
}

export function setSetting(db: Db, key: string, value: unknown): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(value),
  );
}

/** Base64url keys cannot terminate PRAGMA string literals. */
const SAFE_KEY = /^[A-Za-z0-9_-]+$/;
const keyLiteral = (key: string): string => {
  if (!SAFE_KEY.test(key)) throw new Error('Archive key has an unexpected format.');
  return key;
};

/**
 * Encrypts (key) or decrypts (null) the open database in place (SQLite3MultipleCiphers, default cipher).
 * Rekeying isn't supported in WAL mode, so the journal switches out and back. A throw may follow a completed
 * rekey (the WAL restore failed): read the result from encryptedOnDisk, not from the throw.
 */
export function rekey(db: Db, key: string | null): void {
  db.pragma('journal_mode = DELETE');
  db.pragma(`rekey = '${key === null ? '' : keyLiteral(key)}'`);
  configureArchiveReads(db, key);
  db.pragma('journal_mode = WAL');
}

/** SQLite's result code for a file that doesn't read as a database: encrypted, when read without its key. */
const NOT_A_DATABASE = 'SQLITE_NOTADB';

/** Whether a database file exists with pages written; a new one is made with whatever key it is given. */
const hasPages = (path: string): boolean => existsSync(path) && statSync(path).size > 0;

/**
 * The file at `path` as one keyless connection reads it now: no database pages (`absent`), readable (`plaintext`), or
 * refused as not a database (`encrypted`). Throws when the read fails otherwise, including a file gone before it opened.
 */
export function encryptionOnDisk(path: string): ArchiveEncryption {
  if (!hasPages(path)) return 'absent';
  const probe = new Database(path, { fileMustExist: true });
  try {
    probe.prepare('SELECT count(*) FROM sqlite_master').get();
    // Pages read through this connection: a file emptied after the size check reads as absent, never plaintext.
    return (probe.pragma('page_count', { simple: true }) as number) > 0 ? 'plaintext' : 'absent';
  } catch (err) {
    if ((err as { code?: string }).code === NOT_A_DATABASE) return 'encrypted';
    throw err;
  } finally {
    probe.close();
  }
}

/** Whether the file at `path` holds an encrypted database: one a keyless connection can't read. A missing or empty file holds none. */
export const encryptedOnDisk = (path: string): boolean => encryptionOnDisk(path) === 'encrypted';

/** A connection to the encrypted file at `path` with the first of `keys` it reads with; throws when none does. */
function openEncrypted(path: string, keys: readonly string[]): { db: Db; key: string } {
  for (const key of keys) {
    const db = new Database(path, { fileMustExist: true });
    try {
      db.pragma(`key = '${keyLiteral(key)}'`);
      db.prepare('SELECT count(*) FROM sqlite_master').get();
      return { db, key };
    } catch (err) {
      db.close();
      if ((err as { code?: string }).code !== NOT_A_DATABASE) throw err;
    }
  }
  throw new Error('The archive is encrypted, and no stored archive key opens it.');
}

/**
 * Opens (creating if needed) the archive database, and brings its schema up to date. An encrypted file opens with
 * whichever of `keys` it was encrypted with; a plaintext or new file with none (an unused key may be one a stopped change left).
 */
export function openDb(path: string, keys: readonly string[] = []): Db {
  for (const key of keys) keyLiteral(key); // all of them, though a plaintext file uses none
  const opened = encryptionOnDisk(path) === 'encrypted' ? openEncrypted(path, keys) : { db: new Database(path), key: null };
  const { db } = opened;
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  // Incremental auto-vacuum lets retention hand freed pages back to the disk; switching an existing file takes one VACUUM.
  if (db.pragma('auto_vacuum', { simple: true }) !== AUTO_VACUUM_INCREMENTAL) {
    db.pragma('auto_vacuum = INCREMENTAL');
    compact(db);
  }
  // The WAL file keeps its largest size until truncated (a VACUUM passes the whole database through it).
  db.pragma('wal_checkpoint(TRUNCATE)');
  // SQL reads of the payload go through payloadSql (messageContent.ts), whose msg_json() reads compressed rows like plain ones.
  db.function('msg_json', { deterministic: true }, (v: unknown) => rawJsonText(v as string | Buffer | null));
  configureArchiveReads(db, opened.key);
  return db;
}

/** Runs migrations and installs current views atomically. Drops views during migrations to avoid ALTER TABLE reparsing intermediate definitions. */
export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  db.transaction(() => {
    if (current < migrations.length) {
      dropArchiveViews(db);
      for (const step of migrations.slice(current)) applyMigration(db, step);
      db.pragma(`user_version = ${migrations.length}`);
    }
    installArchiveViews(db);
  })();
}

