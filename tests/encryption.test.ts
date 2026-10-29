import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3-multiple-ciphers';
import { encryptedOnDisk, encryptionOnDisk, openDb, rekey } from '../src/core/db';
import { tempDir } from './helpers';

const KEY = 'dGVzdC1rZXktZm9yLWNoYXR0eXBvcA'; // base64 of "test-key-for-chattypop" gitleaks:allow

describe('archive encryption', () => {
  it('encrypts in place, then opens only with the key, and decrypts back', () => {
    const path = join(tempDir(), 'archive.db');
    const db = openDb(path);
    db.prepare("INSERT INTO settings (key, value) VALUES ('probe', '1')").run();
    rekey(db, KEY);
    db.close();

    expect(() => openDb(path)).toThrow(/no stored archive key opens it/);
    const keyed = openDb(path, [KEY]);
    expect(keyed.prepare("SELECT value FROM settings WHERE key = 'probe'").pluck().get()).toBe('1');
    rekey(keyed, null);
    keyed.close();
    expect(openDb(path).prepare("SELECT value FROM settings WHERE key = 'probe'").pluck().get()).toBe('1');
  });

  it('reads a missing file as absent, never as plaintext a key could be deleted for', () => {
    const path = join(tempDir(), 'archive.db');
    expect(encryptionOnDisk(path)).toBe('absent');
    const db = openDb(path);
    expect(encryptionOnDisk(path)).toBe('plaintext');
    rekey(db, KEY);
    db.close();
    expect(encryptionOnDisk(path)).toBe('encrypted');
    rmSync(path);
    writeFileSync(path, ''); // emptied: no pages to read
    expect(encryptionOnDisk(path)).toBe('absent');
  });

  it('opens a plaintext file with a key whose encryption never reached it', () => {
    const path = join(tempDir(), 'archive.db');
    openDb(path).close();
    const db = openDb(path, [KEY]); // main saved the key, then the app stopped before the rekey
    expect(db.prepare('SELECT count(*) FROM settings').pluck().get()).toBe(0);
    expect(encryptedOnDisk(path)).toBe(false);
    db.close();
    expect(encryptedOnDisk(path)).toBe(false);
  });

  it('reports the file encrypted when only the journal restore after the rekey failed', () => {
    const path = join(tempDir(), 'archive.db');
    const db = openDb(path);
    const pragma = db.pragma.bind(db);
    let rekeyed = false;
    db.pragma = ((sql: string, opts?: Database.PragmaOptions) => {
      if (sql.startsWith('rekey')) rekeyed = true;
      if (rekeyed && sql === 'journal_mode = WAL') throw new Error('disk I/O error');
      return pragma(sql, opts);
    }) as typeof db.pragma;
    expect(() => rekey(db, KEY)).toThrow(/I\/O/);
    expect(encryptedOnDisk(path)).toBe(true);
    db.close();
    expect(() => openDb(path)).toThrow(/no stored archive key opens it/);
    openDb(path, [KEY]).close();
  });

  it('refuses a key that could break out of the PRAGMA literal', () => {
    const path = join(tempDir(), 'archive.db');
    expect(() => openDb(path, ["x'; DROP TABLE settings; --"])).toThrow(/unexpected format/);
  });
});
