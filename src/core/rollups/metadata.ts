import type { Db } from '../db';
import { readArchive } from '../reads/archiveReads';
import { MS_PER_S } from '@shared/units';
import { reconcileDefinition } from './definitions';

const active = new WeakMap<Db, Promise<boolean>>();

/** Catalog/name events describe broad renderer dependencies; durable entity deltas bound aggregate invalidation to affected archive partitions. */
export function installMetadataTriggers(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS rollup_metadata_pending (
    entity TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(entity, id));`);
  const tables = [
    ['channels', 'channel', 'id', ['name', 'guild_id', 'kind', 'parent_id', 'overwrites']],
    ['guilds', 'guild', 'id', ['name', 'features', 'owner_id']],
    ['users', 'user', 'id', ['username', 'global_name', 'avatar', 'name_style', 'bot']],
    ['members', 'guild', 'guild_id', ['nick', 'roles', 'left_at']],
    ['roles', 'guild', 'guild_id', ['name', 'position', 'color', 'raw_json']],
  ] as const;
  for (const [table, entity, id, columns] of tables) for (const operation of ['insert', 'update', 'delete']) {
    const aliases = operation === 'insert' ? ['new'] : operation === 'delete' ? ['old'] : ['old', 'new'];
    const changed = operation === 'update' ? ` OF ${columns.join(', ')} ON ${table}
      WHEN ${columns.map((c) => `old.${c} IS NOT new.${c}`).join(' OR ')}` : ` ON ${table}`;
    reconcileDefinition(db, `metadata/${table}/${operation}`, `CREATE TRIGGER rollup_metadata_${table}_${operation}
      AFTER ${operation.toUpperCase()}${changed} BEGIN
      ${aliases.map((alias) => `INSERT INTO rollup_metadata_pending(entity, id) VALUES ('${entity}', ${alias}.${id})
        ON CONFLICT(entity, id) DO UPDATE SET revision = revision + 1;`).join(' ')} END;`);
  }
}

export const metadataPending = (db: Db): boolean => Boolean(db.prepare('SELECT 1 FROM rollup_metadata_pending LIMIT 1').get());

/** Indexed existence checks invalidate clean tokens before metadata discovery, without enumerating messages or disabling unrelated rollups. */
export function metadataAffects(db: Db, rollup: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM rollup_metadata_pending p
    WHERE EXISTS (SELECT 1 FROM rollup_kinds k WHERE k.rollup = ? AND (k.kind = 'names' OR (p.entity != 'user' AND k.kind = 'channels')))
      AND ((p.entity = 'channel' AND (
        EXISTS (SELECT 1 FROM messages m WHERE m.channel_id = p.id)
        OR EXISTS (SELECT 1 FROM attachments a WHERE a.channel_id = p.id)
        OR EXISTS (SELECT 1 FROM links l WHERE l.first_channel_id = p.id)
        OR EXISTS (SELECT 1 FROM rollup_partitions r WHERE r.channel_id = p.id)))
      OR (p.entity = 'guild' AND EXISTS (SELECT 1 FROM channels c JOIN messages m ON m.channel_id = c.id WHERE c.guild_id = p.id))
      OR (p.entity = 'user' AND (EXISTS (SELECT 1 FROM messages m WHERE m.author_id = p.id)
        OR EXISTS (SELECT 1 FROM links l WHERE l.first_author_id = p.id)))) LIMIT 1`).get(rollup));
}

interface Delta { entity: string; id: string; revision: number; partitions: string }

async function drain(db: Db, signal: AbortSignal): Promise<boolean> {
  if (!metadataPending(db)) return true;
  const byChannel = [
    ['messages', 'channel_id', 'ts'], ['attachments', 'channel_id', 'ts'], ['links', 'first_channel_id', 'first_ts'],
  ].map(([table, channel, ts]) => `SELECT s.entity, s.id, t.${channel} AS channel_id, date(t.${ts} / ${MS_PER_S}, 'unixepoch') AS day
    FROM scope s CROSS JOIN ${table} t ON t.${channel} = s.channel_id WHERE t.${ts} IS NOT NULL`);
  const rows = await readArchive<Delta>(db, `WITH scope AS (
    SELECT entity, id, id AS channel_id FROM rollup_metadata_pending WHERE entity = 'channel'
    UNION SELECT p.entity, p.id, c.id FROM rollup_metadata_pending p JOIN channels c ON c.guild_id = p.id WHERE p.entity = 'guild'),
    parts AS (${byChannel.join(' UNION ')}
      UNION SELECT s.entity, s.id, p.channel_id, p.day FROM scope s CROSS JOIN rollup_partitions p ON p.channel_id = s.channel_id
      UNION SELECT p.entity, p.id, m.channel_id, date(m.ts / ${MS_PER_S}, 'unixepoch')
        FROM rollup_metadata_pending p CROSS JOIN messages m ON m.author_id = p.id WHERE p.entity = 'user'
      UNION SELECT p.entity, p.id, a.channel_id, date(a.ts / ${MS_PER_S}, 'unixepoch') FROM rollup_metadata_pending p
        CROSS JOIN messages m ON m.author_id = p.id JOIN attachments a ON a.message_id = m.id WHERE p.entity = 'user' AND a.ts IS NOT NULL
      UNION SELECT p.entity, p.id, l.first_channel_id, date(l.first_ts / ${MS_PER_S}, 'unixepoch')
        FROM rollup_metadata_pending p CROSS JOIN links l ON l.first_author_id = p.id WHERE p.entity = 'user')
    SELECT p.entity, p.id, p.revision, (SELECT json_group_array(json_object('channel', channel_id, 'day', day))
      FROM parts t WHERE t.entity = p.entity AND t.id = p.id) AS partitions FROM rollup_metadata_pending p`, [], signal, 'background');
  signal.throwIfAborted();
  for (const row of rows) {
    db.transaction(() => {
      if (db.prepare('SELECT revision FROM rollup_metadata_pending WHERE entity = ? AND id = ?').pluck().get(row.entity, row.id) !== row.revision) return;
      const kinds = row.entity === 'user' ? ['names'] : ['names', 'channels'];
      const mark = db.prepare(`INSERT INTO rollup_dirty(rollup, channel_id, day)
        SELECT DISTINCT rollup, ?, ? FROM rollup_kinds WHERE kind IN (SELECT value FROM json_each(?))
        ON CONFLICT(rollup, channel_id, day) DO UPDATE SET revision = revision + 1`);
      for (const part of JSON.parse(row.partitions) as { channel: string; day: string }[]) mark.run(part.channel, part.day, JSON.stringify(kinds));
      db.prepare('DELETE FROM rollup_metadata_pending WHERE entity = ? AND id = ?').run(row.entity, row.id);
    })();
    await new Promise<void>((resolve) => setImmediate(resolve));
    signal.throwIfAborted();
  }
  return !metadataPending(db);
}

export function seedRollupMetadata(db: Db, signal: AbortSignal): Promise<boolean> {
  const pending = active.get(db);
  if (pending) return pending;
  const work = drain(db, signal).finally(() => active.delete(db));
  active.set(db, work);
  return work;
}
