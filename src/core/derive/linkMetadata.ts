// Provenance follows each independently filled preview field, rather than the URL's earliest share.
import type { Db } from '../db';
import { rawJsonText } from '../rawJson';
import { extractLinks } from './links';
import type { DerivableMessage } from './deriveMessage';

export const LINK_METADATA_FIELDS = ['title', 'description', 'thumbnail_url', 'site'] as const;
const PROPERTY = { title: 'title', description: 'description', thumbnail_url: 'thumbnailUrl', site: 'site' } as const;
/** Bounds migration memory without holding an iterator open during writes. */
const BACKFILL_BATCH = 500;
type Source = { messageId: string; channelId: string };
type Metadata = Record<typeof LINK_METADATA_FIELDS[number], string | null>;
type Share = { id: string; channel_id: string; raw_json: string | Buffer | null };

/** Current payload evidence for one URL, without trusting the URL's stored preview. */
function shareLink(share: Share, url: string) {
  const raw = rawJsonText(share.raw_json);
  if (!raw) return undefined;
  const m = JSON.parse(raw) as DerivableMessage;
  return extractLinks(m.content ?? '', m.embeds, m.author?.bot === true).find((l) => l.url === url);
}

/** Source edits replace their fields; other shares fill absent or untrusted fields. */
const replaces = (field: string): string => `(links.${field} IS NULL OR
  json_extract(links.metadata_sources, '$.${field}.messageId') = excluded.first_message_id OR
  (json_extract(links.metadata_sources, '$.${field}.messageId') IS NULL AND excluded.${field} IS NOT NULL))`;

export const LINK_METADATA_UPDATES = LINK_METADATA_FIELDS.map((field) =>
  `${field} = CASE WHEN ${replaces(field)} THEN excluded.${field} ELSE links.${field} END`,
).concat(`metadata_sources = json_set(COALESCE(links.metadata_sources, '{}'), ${LINK_METADATA_FIELDS.map((field) =>
  `'$.${field}', json(CASE WHEN ${replaces(field)}
    THEN json_extract(excluded.metadata_sources, '$.${field}') ELSE json_extract(links.metadata_sources, '$.${field}') END)`,
).join(', ')})`).join(', ');

/** Source records for every field this share actually supplied. */
export function metadataSources(values: readonly (string | null)[], messageId: string, channelId: string): string {
  return JSON.stringify(Object.fromEntries(LINK_METADATA_FIELDS.flatMap((field, i) =>
    values[i] === null ? [] : [[field, { messageId, channelId }]],
  )));
}

/** When an edit removes a supplying share, adopt remaining payload evidence or clear its fields. */
export function replaceRemovedMetadata(db: Db, ids: number[], messageId: string): void {
  if (!ids.length) return;
  const rows = db.prepare('SELECT * FROM links WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)) as
    (Metadata & { id: number; url: string; metadata_sources: string | null })[];
  const shares = db.prepare(`SELECT m.id, m.channel_id, m.raw_json FROM message_links ml JOIN messages m ON m.id = ml.message_id
    WHERE ml.link_id = ? ORDER BY m.seq`);
  const update = db.prepare('UPDATE links SET title = ?, description = ?, thumbnail_url = ?, site = ?, metadata_sources = ? WHERE id = ?');
  for (const row of rows) {
    const sources = JSON.parse(row.metadata_sources ?? '{}') as Partial<Record<keyof Metadata, Source | null>>;
    const fields = LINK_METADATA_FIELDS.filter((f) => sources[f]?.messageId === messageId);
    if (!fields.length) continue;
    const candidates = (shares.all(row.id) as Share[]).map((s) => ({ share: s, link: shareLink(s, row.url) }));
    for (const field of fields) {
      const candidate = candidates.find((c) => c.link?.[PROPERTY[field]] != null);
      row[field] = candidate?.link?.[PROPERTY[field]] ?? null;
      if (candidate) sources[field] = { messageId: candidate.share.id, channelId: candidate.share.channel_id };
      else delete sources[field];
    }
    update.run(...LINK_METADATA_FIELDS.map((f) => row[f]), JSON.stringify(sources), row.id);
  }
}

/** Additive upgrade. Ambiguous or unavailable payload evidence stays untrusted instead of guessing the first share. */
export function addLinkMetadataSources(db: Db): void {
  db.exec('ALTER TABLE links ADD COLUMN metadata_sources TEXT');
  const batch = db.prepare('SELECT id, url, title, description, thumbnail_url, site FROM links WHERE id > ? ORDER BY id LIMIT ?');
  const shares = db.prepare(`SELECT m.id, m.channel_id, m.raw_json FROM message_links ml JOIN messages m ON m.id = ml.message_id WHERE ml.link_id = ?`);
  const update = db.prepare('UPDATE links SET metadata_sources = ? WHERE id = ?');
  for (let after = 0; ;) {
    const rows = batch.all(after, BACKFILL_BATCH) as ({ id: number; url: string } & Metadata)[];
    if (!rows.length) break;
    for (const row of rows) {
      const candidates = new Map<string, Source[]>();
      const evidence = shares.all(row.id) as Share[];
      if (evidence.some((s) => s.raw_json === null)) continue;
      for (const share of evidence) {
        const link = shareLink(share, row.url);
        if (!link) continue;
        for (const field of LINK_METADATA_FIELDS) {
          if (row[field] !== null && link[PROPERTY[field]] === row[field]) {
            candidates.set(field, [...(candidates.get(field) ?? []), { messageId: share.id, channelId: share.channel_id }]);
          }
        }
      }
      update.run(JSON.stringify(Object.fromEntries([...candidates].filter(([, sources]) => sources.length === 1).map(([field, sources]) => [field, sources[0]]))), row.id);
    }
    after = rows.at(-1)!.id;
  }
}
