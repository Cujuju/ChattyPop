// Writes that change how a person's name shows (name, nickname, roles, role colours, a server's role styles) or who can
// see a channel (owner, overwrites), counted by temp triggers, so no writer has to report them: core checks after each
// request and sends archive-changed.namesChanged, scoped to the servers written.
import type { Db } from './db';

/** Columns affecting names, access, or author count policy; every writer shares the archive refresh notification. */
const NAME_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  users: ['username', 'global_name', 'name_style', 'bot'],
  members: ['nick', 'roles', 'left_at'],
  roles: ['position', 'color', 'raw_json'],
  guilds: ['features', 'owner_id'],
  channels: ['overwrites'],
};

/** Per table, the server a row is of; NULL for a user, whose name shows in every server. */
const GUILD_OF: Readonly<Record<string, (row: 'NEW' | 'OLD') => string>> = {
  users: () => 'NULL',
  members: (row) => `${row}.guild_id`,
  roles: (row) => `${row}.guild_id`,
  guilds: (row) => `${row}.id`,
  channels: (row) => `${row}.guild_id`,
};

const bump = (table: string, row: 'NEW' | 'OLD'): string =>
  `BEGIN UPDATE name_writes SET n = n + 1; INSERT INTO name_write_guilds VALUES (${GUILD_OF[table]!(row)}); END`;

/** Temp: per connection, gone at close, so the schema and its migrations never see it. */
const triggersSql = (): string =>
  Object.entries(NAME_COLUMNS)
    .map(([table, columns]) => `
      CREATE TEMP TRIGGER ${table}_name_insert AFTER INSERT ON ${table} ${bump(table, 'NEW')};
      CREATE TEMP TRIGGER ${table}_name_delete AFTER DELETE ON ${table} ${bump(table, 'OLD')};
      CREATE TEMP TRIGGER ${table}_name_update AFTER UPDATE OF ${columns.join(', ')} ON ${table}
        WHEN ${columns.map((c) => `OLD.${c} IS NOT NEW.${c}`).join(' OR ')} ${bump(table, 'NEW')};`)
    .join('');

/** Name writes since the last check: the servers written, or null when any server's names may differ (a user's own). */
export interface NameChange {
  guildIds: string[] | null;
}

/** Installs the triggers on `db`; the returned check gives what changed since it last answered, or null for nothing. */
export function watchNameWrites(db: Db): () => NameChange | null {
  db.exec(`CREATE TEMP TABLE name_writes (n INTEGER NOT NULL); INSERT INTO name_writes VALUES (0);
           CREATE TEMP TABLE name_write_guilds (guild_id TEXT);${triggersSql()}`);
  const guilds = db.prepare('SELECT DISTINCT guild_id FROM temp.name_write_guilds').pluck();
  const clear = db.prepare('DELETE FROM temp.name_write_guilds');
  return () => {
    const written = guilds.all() as (string | null)[];
    if (!written.length) return null;
    clear.run();
    return { guildIds: written.includes(null) ? null : (written as string[]) };
  };
}

const counters = new WeakMap<Db, () => number>();

/** How many name writes `db` has had: changes with every one; null when it isn't watched (watchNameWrites). */
export function nameWriteCount(db: Db): number | null {
  let count = counters.get(db);
  if (!count) {
    if (!db.prepare("SELECT 1 FROM sqlite_temp_master WHERE type = 'table' AND name = 'name_writes'").get()) return null;
    const read = db.prepare('SELECT n FROM temp.name_writes').pluck();
    count = () => read.get() as number;
    counters.set(db, count);
  }
  return count();
}
