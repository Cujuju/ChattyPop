// The owner's server order in Discord's sidebar, as main reads it (main/discord/guildOrder.ts); directory() sorts by it.
import type { Db } from '../db';

/** Replaces the stored order with `guildIds` (top first). Returns whether it changed. */
export function putGuildOrder(db: Db, guildIds: string[]): boolean {
  const before = (db.prepare('SELECT guild_id AS id FROM guild_order ORDER BY position').all() as { id: string }[]).map((r) => r.id);
  if (before.length === guildIds.length && before.every((id, i) => id === guildIds[i])) return false;
  const insert = db.prepare('INSERT OR IGNORE INTO guild_order (guild_id, position) VALUES (?, ?)');
  db.transaction(() => {
    db.prepare('DELETE FROM guild_order').run();
    guildIds.forEach((id, i) => insert.run(id, i));
  })();
  return true;
}
