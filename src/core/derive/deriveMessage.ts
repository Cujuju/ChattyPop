import { writeStatement } from '../writeStatements';
import { MS_PER_S } from '@shared/units';
import type { ArchiveChangeKind } from '@shared/contract';
import { snowflakeToMs } from '@shared/discord';
import { CUSTOM_EMOJI, type CustomEmoji } from '@shared/emoji';
import type { Db } from '../db';
import { extractLinks } from './links';
import { LINK_METADATA_FIELDS, LINK_METADATA_UPDATES, reconcileLinkMetadata } from './linkMetadata';

interface RawAttachment {
  id: string;
  filename: string;
  content_type?: string;
  size?: number;
  width?: number | null;
  height?: number | null;
  url: string;
  /** Alt text. */
  description?: string | null;
  /** Discord's attachment flags (a spoiler's included). */
  flags?: number;
}

export interface DerivableMessage {
  id: string;
  channel_id: string;
  author?: { id: string; bot?: boolean };
  content?: string;
  attachments?: RawAttachment[];
  embeds?: unknown;
  reactions?: { emoji?: { id?: string | null; name?: string | null; animated?: boolean } }[];
}

/** Custom emoji used in the text and in reactions (Unicode emoji render from the system font). */
function customEmojis(m: DerivableMessage): CustomEmoji[] {
  const found = [...(m.content ?? '').matchAll(CUSTOM_EMOJI)].map((x) => ({ id: x[3]!, name: x[2]!, animated: x[1] === 'a' }));
  for (const r of m.reactions ?? []) {
    if (r.emoji?.id && r.emoji.name) found.push({ id: r.emoji.id, name: r.emoji.name, animated: Boolean(r.emoji.animated) });
  }
  return found;
}

/** On an attachment upsert: a failed download whose URL changed (SET expressions read the row before the update). */
const REQUEUE = "status = 'failed' AND url IS NOT excluded.url";

/**
 * Derives attachment rows and links idempotently. Updates attachment metadata and marks removals; safe for inserts and
 * repeated MESSAGE_UPDATE events. A failed download whose signed URL Discord re-issued is queued again with fresh retries.
 */
export interface DerivedChange {
  kinds: ArchiveChangeKind[];
  insertOnly: boolean;
  relatedLinks: { channelId: string; day: string }[];
}

export function deriveMessage(db: Db, m: DerivableMessage, authorId: string): DerivedChange {
  const kinds = new Set<ArchiveChangeKind>();
  let insertOnly = true;
  const relatedLinks: DerivedChange['relatedLinks'] = [];
  const addAttachment = writeStatement(db, 
    `INSERT INTO attachments (id, message_id, channel_id, filename, content_type, size, width, height, url, description, flags, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET url = excluded.url, filename = excluded.filename, description = excluded.description, flags = excluded.flags,
       status = CASE WHEN ${REQUEUE} THEN 'pending' ELSE status END, attempts = CASE WHEN ${REQUEUE} THEN 0 ELSE attempts END,
       retry_at = CASE WHEN ${REQUEUE} THEN NULL ELSE retry_at END, error = CASE WHEN ${REQUEUE} THEN NULL ELSE error END`,
  );
  const ts = m.attachments?.length ? writeStatement(db, 'SELECT ts FROM messages WHERE id = ?').pluck().get(m.id) as number | undefined : undefined;
  for (const a of m.attachments ?? []) {
    kinds.add('attachments');
    addAttachment.run(a.id, m.id, m.channel_id, a.filename, a.content_type ?? null, a.size ?? null, a.width ?? null, a.height ?? null, a.url, a.description ?? null, a.flags ?? null, ts ?? snowflakeToMs(m.id));
  }
  // Only a payload that lists attachments says which remain; a partial update without the field says nothing.
  if (Array.isArray(m.attachments)) {
    const removed = writeStatement(db, 
      `UPDATE attachments SET removed_at = ? WHERE message_id = ? AND removed_at IS NULL
       AND id NOT IN (SELECT value FROM json_each(?))`,
    ).run(Date.now(), m.id, JSON.stringify(m.attachments.map((a) => a.id)));
    if (removed.changes) kinds.add('attachments');
  }

  const addEmoji = writeStatement(db, 'INSERT OR IGNORE INTO emojis (id, name, animated) VALUES (?, ?, ?)');
  for (const e of customEmojis(m)) addEmoji.run(e.id, e.name, e.animated ? 1 : 0);

  const upsertLink = writeStatement(db, 
    `INSERT INTO links (url, platform, title, description, thumbnail_url, site, first_message_id, first_channel_id, first_author_id, first_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET
       -- Backfill stores older messages after newer ones; the earliest share is the link's "first".
       first_message_id = CASE WHEN excluded.first_ts < links.first_ts THEN excluded.first_message_id ELSE links.first_message_id END,
       first_channel_id = CASE WHEN excluded.first_ts < links.first_ts THEN excluded.first_channel_id ELSE links.first_channel_id END,
       first_author_id = CASE WHEN excluded.first_ts < links.first_ts THEN excluded.first_author_id ELSE links.first_author_id END,
       first_ts = MIN(links.first_ts, excluded.first_ts),
       ${LINK_METADATA_UPDATES}
     RETURNING id`,
  );
  const linkMessage = writeStatement(db, `INSERT INTO message_links (message_id, link_id, ${LINK_METADATA_FIELDS.map((f) => `metadata_${f}`).join(', ')})
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(message_id, link_id) DO UPDATE SET
    ${LINK_METADATA_FIELDS.map((f) => `metadata_${f} = excluded.metadata_${f}`).join(', ')}`);
  const linkIds: number[] = [];
  for (const l of extractLinks(m.content ?? '', m.embeds, m.author?.bot === true)) {
    kinds.add('links');
    const existed = writeStatement(db, 'SELECT id FROM links WHERE url = ?').get(l.url);
    if (existed) insertOnly = false;
    const values = [l.title, l.description, l.thumbnailUrl, l.site];
    const { id } = upsertLink.get(l.url, l.platform, ...values, m.id, m.channel_id, authorId, snowflakeToMs(m.id)) as {
      id: number;
    };
    linkMessage.run(m.id, id, ...values);
    linkIds.push(id);
    if (existed) {
      const shares = writeStatement(db, `SELECT DISTINCT m.channel_id AS channelId, date(m.ts / ${MS_PER_S}, 'unixepoch') AS day
        FROM message_links ml JOIN messages m ON m.id = ml.message_id WHERE ml.link_id = ?`)
        .all(id) as { channelId: string; day: string }[];
      for (const row of shares) relatedLinks.push(row);
    }
  }
  // Text and embeds are where links come from: a payload with both says which the message still shares (an edit may drop some).
  // The link rows stay, as other messages and the link history refer to them.
  if (typeof m.content === 'string' && Array.isArray(m.embeds)) {
    const removed = writeStatement(db, 'DELETE FROM message_links WHERE message_id = ? AND link_id NOT IN (SELECT value FROM json_each(?)) RETURNING link_id')
      .all(m.id, JSON.stringify(linkIds)) as { link_id: number }[];
    if (removed.length) kinds.add('links');
    for (const r of removed) linkIds.push(r.link_id);
  }
  reconcileLinkMetadata(db, linkIds);
  return { kinds: [...kinds], insertOnly, relatedLinks };
}
