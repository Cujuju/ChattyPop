import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeImage } from 'electron';
import { STORED_MEDIA_MIME, attachmentShard } from '@shared/media';
import { PARTIAL_DOWNLOAD_PREFIX } from './attachmentDownloader';
import type { Media } from './thumbStore';

/** Attachment tiles at up to 128 CSS pixels on a 2x display. */
export const ATTACHMENT_THUMB_PX = 256;
/** JPEG previews retain detail without storing full-resolution images. */
export const ATTACHMENT_THUMB_JPEG_QUALITY = 80;
const THUMB_PREFIX = 'attachment-thumb-';
const pending = new Map<string, Promise<Media | null>>();

/** Local thumbnail by content hash; callers validate the stored name before entering. */
export function attachmentThumb(attachments: string, previews: string, sha256: string, name: string): Promise<Media | null> {
  const cache = join(previews, `${THUMB_PREFIX}${sha256}.jpg`);
  const held = pending.get(cache);
  if (held) return held;
  const made = makeThumbnail(join(attachments, attachmentShard(sha256), name), previews, cache)
    .catch(() => null).finally(() => pending.delete(cache));
  pending.set(cache, made);
  return made;
}

async function makeThumbnail(file: string, previews: string, cache: string): Promise<Media | null> {
  if (!(await stat(file)).isFile()) return null;
  if (existsSync(cache)) return { bytes: await readFile(cache), type: STORED_MEDIA_MIME.jpg! };
  // Electron omits this API on Linux; absent APIs and rejected native decodes fall back to callers' file icons.
  if (typeof nativeImage.createThumbnailFromPath !== 'function') return null;
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
