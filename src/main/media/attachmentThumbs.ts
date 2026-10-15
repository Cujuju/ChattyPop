import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeImage } from 'electron';
import { STORED_MEDIA_MIME, attachmentShard, mediaKind } from '@shared/media';
import { PARTIAL_DOWNLOAD_PREFIX } from './attachmentDownloader';
import type { Media } from './thumbStore';

/** Attachment tiles at up to 128 CSS pixels on a 2x display. */
export const ATTACHMENT_THUMB_PX = 256;
/** JPEG previews retain detail without storing full-resolution images. */
export const ATTACHMENT_THUMB_JPEG_QUALITY = 80;
const THUMB_PREFIX = 'attachment-thumb-';
const THUMB_EXT = '.jpg';
/** A store shard folder: the hash's first characters (attachmentShard), in lowercase hex. */
const SHARD_DIR = /^[0-9a-f]+$/;
/** A stored file: its hash, then its extension. */
const STORED_NAME = /^([0-9a-f]{64})\.[a-z0-9]+$/;
const pending = new Map<string, Promise<Media | null>>();
/** A content hash's thumbnail file in the previews folder. */
const thumbName = (sha256: string): string => `${THUMB_PREFIX}${sha256}${THUMB_EXT}`;

// Electron omits this API on Linux; absent APIs and rejected native decodes fall back to callers' file icons.
const thumbnailsSupported = (): boolean => typeof nativeImage.createThumbnailFromPath === 'function';
/** Images and videos get a thumbnail; other kinds show a file icon. */
const hasPicture = (name: string): boolean => ['image', 'video'].includes(mediaKind({ contentType: null, filename: name }));

/** Local thumbnail by content hash; callers validate the stored name before entering. */
export function attachmentThumb(attachments: string, previews: string, sha256: string, name: string): Promise<Media | null> {
  const cache = join(previews, thumbName(sha256));
  const held = pending.get(cache);
  if (held) return held;
  const made = makeThumbnail(join(attachments, attachmentShard(sha256), name), previews, cache)
    .catch(() => null).finally(() => pending.delete(cache));
  pending.set(cache, made);
  return made;
}

/** Makes a stored picture's thumbnail ahead of its first view, which otherwise waits on it. */
export async function keepAttachmentThumb(attachments: string, previews: string, name: string): Promise<void> {
  const sha256 = STORED_NAME.exec(name)?.[1];
  if (sha256 && hasPicture(name) && thumbnailsSupported()) await attachmentThumb(attachments, previews, sha256, name);
}

/**
 * Matches the thumbnails to the store: makes those it lacks, one at a time (the native thumbnailer runs one at a time,
 * so a tile on screen waits behind at most one), then removes those whose file has left it (freed, or evicted by the
 * storage cap). A file whose thumbnail fails is tried again next run. Stops when `stopped()`; removes nothing unless
 * every shard was read, so an unreadable store never empties the cache.
 */
export async function backfillAttachmentThumbs(attachments: string, previews: string, stopped: () => boolean): Promise<void> {
  if (!thumbnailsSupported()) return;
  const made = new Set(await readdir(previews).catch(() => []));
  const root = await readdir(attachments).catch(() => null);
  if (!root) return;
  const stored = new Set<string>();
  let complete = true;
  for (const shard of root.filter((d) => SHARD_DIR.test(d))) {
    const names = await readdir(join(attachments, shard)).catch(() => null);
    if (!names) { complete = false; continue; }
    for (const name of names) {
      if (stopped()) return;
      const sha256 = STORED_NAME.exec(name)?.[1];
      if (!sha256) continue;
      stored.add(thumbName(sha256));
      if (!made.has(thumbName(sha256))) await keepAttachmentThumb(attachments, previews, name);
    }
  }
  if (!complete) return;
  for (const name of made) {
    if (stopped()) return;
    if (name.startsWith(THUMB_PREFIX) && name.endsWith(THUMB_EXT) && !stored.has(name)) await rm(join(previews, name), { force: true });
  }
}

async function makeThumbnail(file: string, previews: string, cache: string): Promise<Media | null> {
  if (!(await stat(file)).isFile()) return null;
  if (existsSync(cache)) return { bytes: await readFile(cache), type: STORED_MEDIA_MIME.jpg! };
  if (!thumbnailsSupported()) return null;
  const image = await nativeImage.createThumbnailFromPath(file, { width: ATTACHMENT_THUMB_PX, height: ATTACHMENT_THUMB_PX });
  if (image.isEmpty()) return null;
  const bytes = image.toJPEG(ATTACHMENT_THUMB_JPEG_QUALITY);
  if (!bytes.length) return null;
  await mkdir(previews, { recursive: true });
  const partial = join(previews, `${PARTIAL_DOWNLOAD_PREFIX}${randomUUID()}`);
  try {
    await writeFile(partial, bytes);
    await rename(partial, cache);
  } finally {
    await rm(partial, { force: true });
  }
  return { bytes, type: STORED_MEDIA_MIME.jpg! };
}
