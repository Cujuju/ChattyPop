import { snowflakeToMs } from '@shared/discord';
import { CUSTOM_EMOJI, type CustomEmoji } from '@shared/emoji';
import type { Db } from '../db';
import { extractLinks } from './links';

interface RawAttachment {
  id: string;
  filename: string;
  content_type?: string;
  size?: number;
  width?: number | null;
  height?: number | null;
  url: string;
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

/**
 * Records attachments (queued for download) and shared links for a stored message.
 * Idempotent: safe on every insert and every MESSAGE_UPDATE (embeds often arrive later).
 */
export function deriveMessage(db: Db, m: DerivableMessage, authorId: string): void {
  const addAttachment = db.prepare(
    `INSERT INTO attachments (id, message_id, channel_id, filename, content_type, size, width, height, url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET url = excluded.url`,
  );
  for (const a of m.attachments ?? []) {
    addAttachment.run(a.id, m.id, m.channel_id, a.filename, a.content_type ?? null, a.size ?? null, a.width ?? null, a.height ?? null, a.url);
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
