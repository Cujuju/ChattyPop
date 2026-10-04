import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb, rekey } from '../src/core/db';
import { tempDir } from './helpers';

const KEY = 'dGVzdC1rZXktZm9yLWNoYXR0eXBvcA'; // base64 of "test-key-for-chattypop" gitleaks:allow

describe('archive encryption', () => {
  it('encrypts in place, then opens only with the key, and decrypts back', () => {
    const path = join(tempDir(), 'archive.db');
    const db = openDb(path);
    db.prepare("INSERT INTO settings (key, value) VALUES ('probe', '1')").run();
    rekey(db, KEY);
    db.close();

    expect(() => openDb(path)).toThrow(/not a database/);
    const keyed = openDb(path, KEY);
    expect(keyed.prepare("SELECT value FROM settings WHERE key = 'probe'").pluck().get()).toBe('1');
    rekey(keyed, null);
    keyed.close();
    expect(openDb(path).prepare("SELECT value FROM settings WHERE key = 'probe'").pluck().get()).toBe('1');
  });

  it('refuses a key that could break out of the PRAGMA literal', () => {
    const path = join(tempDir(), 'archive.db');
    expect(() => openDb(path, "x'; DROP TABLE settings; --")).toThrow(/unexpected format/);
  });
});
