// Managed archive views: openDb installs the registry's after every upgrade and on every open, never a migration.
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { describe, expect, it } from 'vitest';
import { ARCHIVE_VIEWS, archiveViewSql } from '../src/core/archiveViews';
import { migrate, openDb, setSetting, type Db } from '../src/core/db';
import { HIDDEN_SCOPE_TABLE } from '../src/core/hiddenScope';
import { MIGRATIONS } from '../src/core/migrations';
import { seedArchiveViews } from './archiveViewsFixture';
import { VIEWS_BEFORE_SCOPE_TABLE, persistViews } from './frozenArchiveViews';
import { applyMigrations, migrationIndex, tempDir } from './helpers';

const storedViews = (db: Db): Record<string, string> => Object.fromEntries(
  (db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'view' AND name GLOB 'archive_*' ORDER BY name").all() as { name: string; sql: string }[])
    .map((r) => [r.name, r.sql]),
);
const registryViews = (): Record<string, string> => Object.fromEntries(Object.keys(ARCHIVE_VIEWS).sort().map((name) => [name, archiveViewSql(name)]));
const version = (db: Db): number => db.pragma('user_version', { simple: true }) as number;
const tableExists = (db: Db, name: string): boolean => db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) !== undefined;

/** Replaces `name` with a view reading a table that is gone: ALTER TABLE ... RENAME fails while it exists. */
function staleView(db: Db, name: string): void {
  db.exec(`CREATE TABLE gone (id); DROP VIEW ${name}; CREATE VIEW ${name} AS SELECT id FROM gone; DROP TABLE gone;`);
}

/** A pending step whose ALTER TABLE reparses every view in the database. */
const RENAMING_STEP = 'CREATE TABLE probe (a); ALTER TABLE probe RENAME COLUMN a TO b;';

describe('managed archive views', () => {
  it('a fresh archive gets exactly the registry views', () => {
    const db = openDb(join(tempDir(), 'fresh.db'));
    expect(version(db)).toBe(MIGRATIONS.length);
    expect(storedViews(db)).toEqual(registryViews());
  });

  it('an archive at an older version, holding the views of then, upgrades to the registry views over its rows', () => {
    const path = join(tempDir(), 'old.db');
    const old = new Database(path);
    applyMigrations(old, 0, migrationIndex(HIDDEN_SCOPE_TABLE));
    persistViews(old, VIEWS_BEFORE_SCOPE_TABLE);
    seedArchiveViews(old);
    old.close();
    const db = openDb(path);
    expect(version(db)).toBe(MIGRATIONS.length);
    expect(storedViews(db)).toEqual(registryViews());
    setSetting(db, 'privacyMode', true);
    db.close();
    const bare = new Database(path);
    try {
      expect(bare.prepare('SELECT id FROM archive_messages ORDER BY id').pluck().all()).toEqual(['m-missing', 'm-open']);
      expect(bare.prepare('SELECT id FROM archive_all_messages ORDER BY id').pluck().all())
        .toEqual(bare.prepare('SELECT id FROM messages ORDER BY id').pluck().all());
    } finally {
      bare.close();
    }
  });

  it('a current archive gets changed, missing and retired views put right on open, without a migration', () => {
    const path = join(tempDir(), 'current.db');
    openDb(path).close();
    const raw = new Database(path);
    raw.exec(`DROP VIEW archive_users; CREATE VIEW archive_users AS SELECT 1 AS id;
      DROP VIEW archive_names; CREATE VIEW archive_retired AS SELECT 1 AS id;`);
    raw.close();
    const db = openDb(path);
    expect(version(db)).toBe(MIGRATIONS.length);
    expect(storedViews(db)).toEqual(registryViews());
  });

  it('writes no schema change when opening a current archive whose views are current', () => {
    const path = join(tempDir(), 'unchanged.db');
    openDb(path).close();
    const schemaVersion = (): number => {
      const raw = new Database(path);
      try {
        return raw.pragma('schema_version', { simple: true }) as number;
      } finally {
        raw.close();
      }
    };
    const before = schemaVersion();
    openDb(path).close();
    expect(schemaVersion()).toBe(before);
  });

  it('drops the views while steps run, so ALTER TABLE never meets a stale one', () => {
    const db = openDb(join(tempDir(), 'stale.db'));
    staleView(db, 'archive_users');
    expect(() => db.transaction(() => db.exec(RENAMING_STEP))()).toThrow(/archive_users/);
    migrate(db, [...MIGRATIONS, RENAMING_STEP]);
    expect(version(db)).toBe(MIGRATIONS.length + 1);
    expect(storedViews(db)).toEqual(registryViews());
  });

  it('rolls a failed upgrade back whole, leaving the previous schema and views', () => {
    const db = openDb(join(tempDir(), 'failed.db'));
    staleView(db, 'archive_users');
    const before = storedViews(db);
    const failing = (): void => {
      throw new Error('step failed');
    };
    expect(() => migrate(db, [...MIGRATIONS, 'CREATE TABLE added (a);', failing])).toThrow('step failed');
    expect(version(db)).toBe(MIGRATIONS.length);
    expect(tableExists(db, 'added')).toBe(false);
    expect(storedViews(db)).toEqual(before);
  });
});
