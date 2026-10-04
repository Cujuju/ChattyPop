// Every part of a message a plugin can make text for: its media (attachments, its embeds' images and videos, the images
// plugins found for its links) and its embeds' text. Part keys tie a plugin's notes and derived text to what they are of.
import { embedShowsPictures, embedVideoHasSound, mediaKind, mediaSize } from '@shared/media';
import type { ArchiveEmbed, MediaSize } from '@shared/types/archive';
import type { Db } from './db';
import { archivePayloads } from './plugins/archivePayloads';
import { embedsFrom } from './queries/messageExtras';

export type MessagePartSource = 'attachment' | 'embed' | 'link';
export type MediaPartKind = 'image' | 'audio' | 'video';

/** An attachment as the store has it. */
export interface StoredAttachment {
  id: string;
  filename: string;
  /** pending → stored | failed (or evicted by the store's cap). */
  status: string;
  /** Its stored file's content address; null until stored. */
  sha256: string | null;
}

/** A picture, sound or video the message shows. */
export interface MediaPart {
  /** Stable within the message: partKey.attachment, partKey.embed or partKey.link. */
  key: string;
  source: MessagePartSource;
  kind: MediaPartKind;
  /** Where it is fetched from: the attachment's CDN URL, Discord's media proxy for an embed, the host's URL for a link image. */
  url: string;
  size: MediaSize | null;
  /** Set for an attachment. */
  attachment: StoredAttachment | null;
}

/** An embed's own words (title and description). */
export interface TextPart {
  key: string;
  source: 'embed';
  kind: 'text';
  text: string;
}

export type MessagePart = MediaPart | TextPart;

/** Part keys. An embed's media is keyed by its proxied URL, so the same file shown twice is one part. */
export const partKey = {
  attachment: (id: string): string => `attachment:${id}`,
  embed: (url: string): string => `embed:${url}`,
  link: (url: string): string => `link:${url}`,
  /** `index`: the embed's place in the message's embeds as the Archive draws them (embedsFrom). */
  embedText: (index: number): string => `embed-text:${index}`,
};

/** An embed's words to read or translate, or null when it has none. */
export function embedText(e: Pick<ArchiveEmbed, 'title' | 'description'>): string | null {
  const text = [e.title, e.description].filter((s): s is string => !!s?.trim()).join('\n');
  return text || null;
}

/** The parts drawn on embed `e` (the `index`th): its text, images, thumbnail and video, in that order, each once. */
export function embedPartKeys(e: ArchiveEmbed, index: number): string[] {
  const urls = [e.imageUrl, ...(e.moreImages ?? []).map((g) => g.url), e.thumbnailUrl, e.videoUrl].filter((u): u is string => !!u);
  return [partKey.embedText(index), ...new Set(urls.map(partKey.embed))];
}

/** Each message's parts in the order it shows them (attachments, embeds, link images); a message with none is left out. */
export function messageParts(db: Db, ids: readonly string[]): Map<string, MessagePart[]> {
  const out = new Map<string, MessagePart[]>();
  if (!ids.length) return out;
  const add = (messageId: string, part: MessagePart): void => {
    const list = out.get(messageId) ?? [];
    // One file shown twice (an embed repeating an attachment) is one part.
    if (part.kind !== 'text' && list.some((p) => p.kind !== 'text' && p.url === part.url)) return;
    list.push(part);
    out.set(messageId, list);
  };
  const idsJson = JSON.stringify(ids);
  const attachments = db
    .prepare(
      `SELECT id, message_id AS messageId, filename, content_type AS contentType, width, height, url, sha256, status
       FROM attachments WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY rowid`,
    )
    .all(idsJson) as (StoredAttachment & { messageId: string; contentType: string | null; width: number | null; height: number | null; url: string })[];
  for (const a of attachments) {
    const kind = mediaKind(a);
    if (kind === 'file') continue;
    const attachment = { id: a.id, filename: a.filename, status: a.status, sha256: a.sha256 };
    add(a.messageId, { key: partKey.attachment(a.id), source: 'attachment', kind, url: a.url, size: mediaSize(a), attachment });
  }
  for (const [messageId, p] of archivePayloads(db, ids)) {
    embedsFrom(p.embedsJson).forEach((e, index) => {
      const text = embedText(e);
      if (text) add(messageId, { key: partKey.embedText(index), source: 'embed', kind: 'text', text });
      const media = (kind: MediaPartKind, url: string, size: MediaSize | null): void =>
        add(messageId, { key: partKey.embed(url), source: 'embed', kind, url, size, attachment: null });
      // A video's still or an animation isn't a picture shared to be read.
      if (embedShowsPictures(e.type)) {
        if (e.imageUrl) media('image', e.imageUrl, e.imageSize);
        for (const g of e.moreImages ?? []) media('image', g.url, g.size);
        if (e.thumbnailUrl) media('image', e.thumbnailUrl, e.thumbnailSize);
      }
      if (e.videoUrl && embedVideoHasSound(e.type)) media('video', e.videoUrl, e.videoSize);
    });
  }
  const linked = db
    .prepare(
      `SELECT ml.message_id AS messageId, li.image_url AS url, li.width, li.height
       FROM message_links ml JOIN links l ON l.id = ml.link_id JOIN link_images li ON li.url = l.url
       WHERE ml.message_id IN (SELECT value FROM json_each(?)) ORDER BY ml.link_id, li.source, li.ord`,
    )
    .all(idsJson) as { messageId: string; url: string; width: number | null; height: number | null }[];
  for (const l of linked) add(l.messageId, { key: partKey.link(l.url), source: 'link', kind: 'image', url: l.url, size: mediaSize(l), attachment: null });
  return out;
}
