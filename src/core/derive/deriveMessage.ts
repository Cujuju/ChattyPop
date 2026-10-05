import { snowflakeToMs } from '@shared/discord';
import { CUSTOM_EMOJI, type CustomEmoji } from '@shared/emoji';
import { parseRawJson, type Db } from '../db';
import { extractLinks } from './links';

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

/** What an edit can change of an attachment, as one comparable string. */
const attachmentState = (a: { id: string; filename: string; description?: string | null }): string => JSON.stringify([a.id, a.filename, a.description ?? null]);

/**
 * Brings a stored payload's attachments up to `m`'s when they differ. A re-fetch with unchanged text otherwise leaves
 * raw_json as first stored, and re-derivation from it would undo a rename or alt text. Call before deriveMessage, which
 * updates the rows compared. Other stored fields stay (a gateway payload's member, which a re-fetch lacks).
 */
export function refreshStoredAttachments(db: Db, m: DerivableMessage): void {
  if (!Array.isArray(m.attachments)) return;
  const stored = db
    .prepare('SELECT id, filename, description FROM attachments WHERE message_id = ? AND removed_at IS NULL ORDER BY rowid')
    .all(m.id) as { id: string; filename: string; description: string | null }[];
  if (stored.map(attachmentState).join() === m.attachments.map(attachmentState).join()) return;
  const payload = parseRawJson<object>(db.prepare('SELECT raw_json FROM messages WHERE id = ?').pluck().get(m.id) as string | Buffer | null);
  if (payload) db.prepare('UPDATE messages SET raw_json = ? WHERE id = ?').run(JSON.stringify({ ...payload, attachments: m.attachments }), m.id);
}

/**
 * Records attachments (queued for download) and shared links for a stored message. An edit's rename (a spoiler toggle)
 * and alt text update the row; an attachment the message no longer lists is marked removed, once: Discord can't re-add it.
 * Idempotent: safe on every insert and every MESSAGE_UPDATE (embeds often arrive later).
 */
export function deriveMessage(db: Db, m: DerivableMessage, authorId: string): void {
  const addAttachment = db.prepare(
    `INSERT INTO attachments (id, message_id, channel_id, filename, content_type, size, width, height, url, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET url = excluded.url, filename = excluded.filename, description = excluded.description`,
  );
  for (const a of m.attachments ?? []) {
    addAttachment.run(a.id, m.id, m.channel_id, a.filename, a.content_type ?? null, a.size ?? null, a.width ?? null, a.height ?? null, a.url, a.description ?? null);
  }
  // Only a payload that lists attachments says which remain; a partial update without the field says nothing.
  if (Array.isArray(m.attachments)) {
    db.prepare(
      `UPDATE attachments SET removed_at = ? WHERE message_id = ? AND removed_at IS NULL
       AND id NOT IN (SELECT value FROM json_each(?))`,
    ).run(Date.now(), m.id, JSON.stringify(m.attachments.map((a) => a.id)));
  }

  const addEmoji = db.prepare('INSERT OR IGNORE INTO emojis (id, name, animated) VALUES (?, ?, ?)');
  for (const e of customEmojis(m)) addEmoji.run(e.id, e.name, e.animated ? 1 : 0);

  const upsertLink = db.prepare(
    `INSERT INTO links (url, platform, title, description, thumbnail_url, site, first_message_id, first_channel_id, first_author_id, first_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET
       -- Backfill stores older messages after newer ones; the earliest share is the link's "first".
       first_message_id = CASE WHEN excluded.first_ts < links.first_ts THEN excluded.first_message_id ELSE links.first_message_id END,
       first_channel_id = CASE WHEN excluded.first_ts < links.first_ts THEN excluded.first_channel_id ELSE links.first_channel_id END,
       first_author_id = CASE WHEN excluded.first_ts < links.first_ts THEN excluded.first_author_id ELSE links.first_author_id END,
       first_ts = MIN(links.first_ts, excluded.first_ts),
       title = COALESCE(links.title, excluded.title),
       description = COALESCE(links.description, excluded.description),
       thumbnail_url = COALESCE(links.thumbnail_url, excluded.thumbnail_url), site = COALESCE(links.site, excluded.site)
     RETURNING id`,
  );
  const linkMessage = db.prepare('INSERT OR IGNORE INTO message_links (message_id, link_id) VALUES (?, ?)');
  for (const l of extractLinks(m.content ?? '', m.embeds, m.author?.bot === true)) {
    const { id } = upsertLink.get(l.url, l.platform, l.title, l.description, l.thumbnailUrl, l.site, m.id, m.channel_id, authorId, snowflakeToMs(m.id)) as {
      id: number;
    };
    linkMessage.run(m.id, id);
  }
}
