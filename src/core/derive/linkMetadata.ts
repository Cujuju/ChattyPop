import { writeStatement } from '../writeStatements';
// Each share retains its own preview evidence; readers match it against the URL's current fields.
import type { Db } from '../db';
import { rawJsonText } from '../rawJson';
import { extractLinks, type ExtractedLink } from './links';
import type { DerivableMessage } from './deriveMessage';

export const LINK_METADATA_FIELDS = ['title', 'description', 'thumbnail_url', 'site'] as const;
const PROPERTY = { title: 'title', description: 'description', thumbnail_url: 'thumbnailUrl', site: 'site' } as const;
/** Bounds migration memory without holding an iterator open during writes. */
const BACKFILL_BATCH = 500;

/** Non-null incoming fields replace the current value; matching older suppliers remain evidence. */
export const LINK_METADATA_UPDATES = LINK_METADATA_FIELDS.map((field) =>
  `${field} = COALESCE(excluded.${field}, links.${field})`,
).join(', ');

/** After edits or removals, keep supported values or adopt the newest remaining share's evidence. */
export function reconcileLinkMetadata(db: Db, ids: number[]): void {
  if (!ids.length) return;
  writeStatement(db, `UPDATE links SET ${LINK_METADATA_FIELDS.map((field) => `${field} = CASE
    WHEN EXISTS (SELECT 1 FROM message_links ml WHERE ml.link_id = links.id AND ml.metadata_${field} = links.${field})
    THEN links.${field} ELSE (SELECT ml.metadata_${field} FROM message_links ml JOIN messages m ON m.id = ml.message_id
      WHERE ml.link_id = links.id AND ml.metadata_${field} IS NOT NULL ORDER BY m.seq DESC LIMIT 1) END`).join(', ')}
    WHERE id IN (SELECT value FROM json_each(?))`).run(JSON.stringify(ids));
}

/** Additive, unshipped upgrade: missing or damaged payloads supply no evidence and never disqualify another share. */
export function addLinkMetadataSources(db: Db): void {
  for (const field of LINK_METADATA_FIELDS) db.exec(`ALTER TABLE message_links ADD COLUMN metadata_${field} TEXT`);
  const batch = writeStatement(db, `SELECT ml.rowid AS share_rowid, ml.message_id, ml.link_id, l.url, m.raw_json
    FROM message_links ml JOIN messages m ON m.id = ml.message_id JOIN links l ON l.id = ml.link_id
    WHERE ml.rowid > ? ORDER BY ml.rowid LIMIT ?`);
  const update = writeStatement(db, `UPDATE message_links SET ${LINK_METADATA_FIELDS.map((f) => `metadata_${f} = ?`).join(', ')}
    WHERE message_id = ? AND link_id = ?`);
  for (let after = 0; ;) {
    const rows = batch.all(after, BACKFILL_BATCH) as {
      share_rowid: number; message_id: string; link_id: number; url: string; raw_json: string | Buffer | null;
    }[];
    if (!rows.length) break;
    for (const row of rows) {
      let link: ExtractedLink | undefined;
      try {
        const raw = rawJsonText(row.raw_json);
        if (!raw) continue;
        const m = JSON.parse(raw) as DerivableMessage;
        link = extractLinks(m.content ?? '', m.embeds, m.author?.bot === true).find((l) => l.url === row.url);
      } catch {
        // A damaged legacy payload must not prevent the archive opening.
      }
      if (link) update.run(...LINK_METADATA_FIELDS.map((f) => link[PROPERTY[f]]), row.message_id, row.link_id);
    }
    after = rows.at(-1)!.share_rowid;
  }
  for (const field of LINK_METADATA_FIELDS) {
    db.exec(`CREATE INDEX message_links_metadata_${field} ON message_links (link_id, metadata_${field}, message_id)
      WHERE metadata_${field} IS NOT NULL`);
  }
}
