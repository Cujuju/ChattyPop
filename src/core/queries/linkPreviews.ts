import type { ArchiveEmbed } from '@shared/contract';
import { embedsFrom } from '@shared/messageExtras';
import type { ArchiveToolScope } from '../ai/archiveTools';
import { toolScopeSql } from '../ai/archiveToolKit';
import { rawJsonText, type Db } from '../db';
import { normalizeUrl } from '../derive/links';

export interface LinkPreview { embed: ArchiveEmbed; source: string }

/** Chooses the first matching bot embed, else the first matching human embed, within visible sharing messages. */
export function linkPreviews(db: Db, ids: readonly number[], scope?: ArchiveToolScope): Map<number, LinkPreview> {
  const out = new Map<number, LinkPreview>();
  if (!ids.length) return out;
  const scoped = scope ? toolScopeSql(scope) : { sql: '1', params: [] };
  const rows = db.prepare(`SELECT ml.link_id AS linkId, l.url, m.id, m.raw_json AS raw
    FROM archive_message_links ml JOIN archive_messages m ON m.id = ml.message_id JOIN links l ON l.id = ml.link_id
    WHERE ml.link_id IN (SELECT value FROM json_each(?)) AND ${scoped.sql} ORDER BY m.ts`)
    .iterate(JSON.stringify(ids), ...scoped.params) as Iterable<{ linkId: number; url: string; id: string; raw: string | Buffer | null }>;
  const bots = new Set<number>();
  for (const row of rows) {
    if (bots.has(row.linkId)) continue;
    const text = rawJsonText(row.raw);
    const payload = text ? JSON.parse(text) as { author?: { bot?: boolean }; embeds?: unknown[] } : null;
    const bot = payload?.author?.bot;
    if (out.has(row.linkId) && !bot) continue;
    const embed = embedsFrom(payload?.embeds ? JSON.stringify(payload.embeds) : null)
      .find((e) => e.url !== null && normalizeUrl(e.url) === row.url);
    if (!embed) continue;
    out.set(row.linkId, { embed, source: row.id });
    if (bot) bots.add(row.linkId);
  }
  return out;
}
