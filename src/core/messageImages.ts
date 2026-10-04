// Every image a message shows (messageParts' images): its image attachments, its embeds' images (Discord's link
// previews), and the images plugins found for its links (a fetched X post's photos, link_images). Image text reads them.
import type { Db } from './db';
import { messageParts, type MediaPart, type MessagePartSource, type StoredAttachment } from './messageParts';

export type MessageImageSource = MessagePartSource;
/** An image attachment as the store has it. */
export type ImageAttachment = StoredAttachment;
export type MessageImage = Omit<MediaPart, 'kind'>;

/** An image a plugin found for a link (link_images). */
export interface LinkImage {
  url: string;
  width?: number;
  height?: number;
}

/** Each message's images, in the order it shows them (attachments, embeds, link images); a message with none is left out. */
export function messageImages(db: Db, ids: readonly string[]): Map<string, MessageImage[]> {
  const out = new Map<string, MessageImage[]>();
  for (const [messageId, parts] of messageParts(db, ids)) {
    const images = parts.flatMap((p) => (p.kind === 'image' ? [{ key: p.key, source: p.source, url: p.url, size: p.size, attachment: p.attachment }] : []));
    if (images.length) out.set(messageId, images);
  }
  return out;
}

/**
 * Stores or replaces (by `source`) a plugin's images for link `url`, with `record` in the same transaction. Returns the
 * messages sharing the link, whose images changed.
 */
export function storeLinkImages(db: Db, url: string, source: string, images: readonly LinkImage[], record?: () => void): string[] {
  return db.transaction(() => {
    record?.();
    db.prepare('DELETE FROM link_images WHERE url = ? AND source = ?').run(url, source);
    const insert = db.prepare('INSERT INTO link_images (url, source, ord, image_url, width, height) VALUES (?, ?, ?, ?, ?, ?)');
    images.forEach((img, ord) => insert.run(url, source, ord, img.url, img.width ?? null, img.height ?? null));
    return db
      .prepare('SELECT DISTINCT ml.message_id FROM message_links ml JOIN links l ON l.id = ml.link_id WHERE l.url = ?')
      .pluck()
      .all(url) as string[];
  })();
}
