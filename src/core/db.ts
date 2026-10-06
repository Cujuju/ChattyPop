import { existsSync, statSync } from 'node:fs';
import Database from 'better-sqlite3-multiple-ciphers';
import type { CoreStatus } from '@shared/contract';
import { dropArchiveViews, installArchiveViews } from './archiveViews';
import { MIGRATIONS, applyMigration, type Migration } from './migrations';
import { rawJsonText } from './rawJson';

export type Db = Database.Database;

/** PRAGMA auto_vacuum value for INCREMENTAL. */
const AUTO_VACUUM_INCREMENTAL = 2;

export { compressRawJson, rawJsonText } from './rawJson';

/** A stored payload parsed; null when there is none. */
export const parseRawJson = <T>(v: string | Buffer | null): T | null => {
  const text = rawJsonText(v);
  return text ? (JSON.parse(text) as T) : null;
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
 * Rekeying isn't supported in WAL mode, so the journal switches out and back.
 */
export function rekey(db: Db, key: string | null): void {
  db.pragma('journal_mode = DELETE');
  db.pragma(`rekey = '${key === null ? '' : keyLiteral(key)}'`);
  db.pragma('journal_mode = WAL');
}

/** Opens (creating if needed) the archive database, with its key when encrypted, and brings its schema up to date. */
export function openDb(path: string, key: string | null = null): Db {
  const db = new Database(path);
  if (key !== null) db.pragma(`key = '${keyLiteral(key)}'`);
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
  // SQL reads of the payload go through msg_json() so compressed rows read like plain ones.
  db.function('msg_json', { deterministic: true }, (v: unknown) => rawJsonText(v as string | Buffer | null));
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

/** SQLite side files in WAL mode; recent writes live in -wal until checkpointed. */
const DB_SIDE_FILES = ['', '-wal', '-shm'];

export function readStatus(db: Db, path: string, mediaBytes: number, encrypted: boolean): Omit<CoreStatus, 'textOverCapBytes'> {
  const { v } = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
  const fts5 = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'fts_messages'").get() !== undefined;
  const dbBytes = DB_SIDE_FILES.reduce((sum, suffix) => sum + (existsSync(path + suffix) ? statSync(path + suffix).size : 0), 0);
  return {
    sqliteVersion: v,
    cipher: String(db.pragma('cipher', { simple: true })),
    encrypted,
    fts5,
    schemaVersion: db.pragma('user_version', { simple: true }) as number,
    dbPath: path,
    dbBytes,
    mediaBytes,
    totalBytes: dbBytes + mediaBytes,
  };
}
