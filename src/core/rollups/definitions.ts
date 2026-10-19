import { createHash } from 'node:crypto';
import type { Db } from '../db';

/** Replaces generated objects atomically; persistent data tables remain compatible with other app versions. */
export function reconcileDefinition(db: Db, key: string, sql: string): void {
  db.exec('CREATE TABLE IF NOT EXISTS rollup_definitions (name TEXT PRIMARY KEY, hash TEXT NOT NULL)');
  const hash = createHash('sha256').update(sql).digest('hex');
  const objects = [...sql.matchAll(/CREATE\s+(TRIGGER|VIEW|INDEX)\s+(?:IF NOT EXISTS\s+)?("[^"]+"|\w+)/gi)];
  const fingerprint = (): string => {
    const rows = db.prepare('SELECT type, name, sql FROM sqlite_schema WHERE name IN (SELECT value FROM json_each(?)) ORDER BY name')
      .all(JSON.stringify(objects.map((match) => match[2]!.replaceAll('"', ''))));
    return `${hash}:${createHash('sha256').update(JSON.stringify(rows)).digest('hex')}`;
  };
  if (db.prepare('SELECT hash FROM rollup_definitions WHERE name = ?').pluck().get(key) === fingerprint()) return;
  db.transaction(() => {
    for (const match of objects) {
      db.exec(`DROP ${match[1]} IF EXISTS ${match[2]}`);
    }
    db.exec(sql);
    for (const match of objects) if (match[1]!.toUpperCase() === 'VIEW') db.prepare(`SELECT * FROM ${match[2]} LIMIT 0`);
    db.prepare('INSERT INTO rollup_definitions VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET hash = excluded.hash').run(key, fingerprint());
  })();
}
