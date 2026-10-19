import { createHash } from 'node:crypto';
import type { Db } from '../db';

/** Replaces generated objects atomically; persistent data tables remain compatible with other app versions. */
export function reconcileDefinition(db: Db, key: string, sql: string): void {
  db.exec('CREATE TABLE IF NOT EXISTS rollup_definitions (name TEXT PRIMARY KEY, hash TEXT NOT NULL)');
  const hash = createHash('sha256').update(sql).digest('hex');
  if (db.prepare('SELECT hash FROM rollup_definitions WHERE name = ?').pluck().get(key) === hash) return;
  db.transaction(() => {
    for (const match of sql.matchAll(/CREATE\s+(TRIGGER|VIEW|INDEX)\s+(?:IF NOT EXISTS\s+)?("[^"]+"|\w+)/gi)) {
      db.exec(`DROP ${match[1]} IF EXISTS ${match[2]}`);
    }
    db.exec(sql);
    db.prepare('INSERT INTO rollup_definitions VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET hash = excluded.hash').run(key, hash);
  })();
}
