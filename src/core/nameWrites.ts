// Writes that change how a person's name shows (name, nickname, roles, role colours, a server's role styles), counted by
// temp triggers, so no writer has to report them: core checks after each request and sends archive-changed.namesChanged.
import type { Db } from './db';

/** Per table, the columns a shown name reads (queries/names.ts, queries/personNames.ts). */
const NAME_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  users: ['username', 'global_name', 'name_style'],
  members: ['nick', 'roles', 'left_at'],
  roles: ['position', 'color', 'raw_json'],
  guilds: ['features'],
};

const BUMP = 'BEGIN UPDATE name_writes SET n = n + 1; END';

/** Temp: per connection, gone at close, so the schema and its migrations never see it. */
const triggersSql = (): string =>
  Object.entries(NAME_COLUMNS)
    .map(([table, columns]) => `
      CREATE TEMP TRIGGER ${table}_name_insert AFTER INSERT ON ${table} ${BUMP};
      CREATE TEMP TRIGGER ${table}_name_delete AFTER DELETE ON ${table} ${BUMP};
      CREATE TEMP TRIGGER ${table}_name_update AFTER UPDATE OF ${columns.join(', ')} ON ${table}
        WHEN ${columns.map((c) => `OLD.${c} IS NOT NEW.${c}`).join(' OR ')} ${BUMP};`)
    .join('');

/** Installs the triggers on `db`; the returned check is true when names changed since it last answered. */
export function watchNameWrites(db: Db): () => boolean {
  db.exec(`CREATE TEMP TABLE name_writes (n INTEGER NOT NULL); INSERT INTO name_writes VALUES (0);${triggersSql()}`);
  const count = db.prepare('SELECT n FROM temp.name_writes').pluck();
  let seen = 0;
  return () => {
    const n = count.get() as number;
    if (n === seen) return false;
    seen = n;
    return true;
  };
}
