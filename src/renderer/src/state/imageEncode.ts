import { ARCHIVE_IMAGE_QUALITY, WEBP_TYPE } from '@shared/imageEncode';

type ImageEncodeAttempt = { kind: 'encoded'; file: Blob } | { kind: 'unsupported' };

/** Re-encodes without resizing, keeping archived pixel dimensions accurate. */
export async function encodeImageForArchive(blob: Blob, opts: { signal?: AbortSignal }): Promise<ImageEncodeAttempt> {
  opts.signal?.throwIfAborted();
  if (typeof createImageBitmap === 'undefined' || typeof OffscreenCanvas === 'undefined') return { kind: 'unsupported' };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    opts.signal?.throwIfAborted();
    return { kind: 'unsupported' };
  }
  try {
    opts.signal?.throwIfAborted();
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) return { kind: 'unsupported' };
    context.drawImage(bitmap, 0, 0);
    const file = await canvas.convertToBlob({ type: WEBP_TYPE, quality: ARCHIVE_IMAGE_QUALITY });
    opts.signal?.throwIfAborted();
    return file.type === WEBP_TYPE ? { kind: 'encoded', file } : { kind: 'unsupported' };
  } catch {
    opts.signal?.throwIfAborted();
    return { kind: 'unsupported' };
  } finally {
    bitmap.close();
  }
}
