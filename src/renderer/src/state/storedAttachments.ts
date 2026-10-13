import { api } from '@/api';
import type { FreeResult } from '@shared/contract';
import { FREE_ATTACHMENTS_MAX } from '@shared/types/attachmentStore';
import { UPLOAD_CHUNK_BYTES } from '@shared/compose';
import { ARCHIVE_ENCODE_PROGRESS_SHARE, type ReplacementExt } from '@shared/attachmentReplacement';
import { compressibleAs, type CompressAs } from '@shared/attachmentCompression';
import { attachmentUrl, mediaType, type StoredFile } from '@shared/media';
import { savesEnough } from '@shared/videoEncode';
import { encodeImageForArchive } from './imageEncode';
import { encodeForArchive } from './videoEncode';
import { onServerScreen } from './ui';

/** What a stored attachment needs to be deleted or compressed. */
export interface StoredAttachmentRef extends StoredFile {
  id: string;
  contentType: string | null;
  status: string;
  animated: boolean;
  compressed: boolean;
  removed?: boolean;
}
export { compressibleAs, type CompressAs };
/** Only app windows on the archive's PC have its replacement pipeline. */
export const canCompressHere = onServerScreen;
export type CompressOutcome = { kind: 'compressed'; savedBytes: number } | { kind: 'skipped'; reason: 'not-smaller' | 'unsupported' };
interface CompressOptions {
  signal?: AbortSignal;
  onProgress?(fraction: number): void;
}
const REPLACEMENT_FORMAT: Record<CompressAs, ReplacementExt> = { video: 'mp4', image: 'webp' };
let serial: Promise<unknown> = Promise.resolve();

/** Hardware encoding runs one file at a time in this window. */
export function compressStored(a: StoredAttachmentRef, opts: CompressOptions = {}): Promise<CompressOutcome> {
  if (opts.signal?.aborted) return Promise.reject(opts.signal.reason);
  return new Promise((resolve, reject) => {
    const cancelled = (): void => reject(opts.signal!.reason);
    opts.signal?.addEventListener('abort', cancelled, { once: true });
    const run = serial.then(() => {
      opts.signal?.removeEventListener('abort', cancelled);
      return compressOne(a, opts);
    });
    serial = run.catch(() => undefined);
    void run.then(resolve, reject);
  });
}

async function compressOne(a: StoredAttachmentRef, opts: CompressOptions): Promise<CompressOutcome> {
  opts.signal?.throwIfAborted();
  if (!canCompressHere) throw new Error('Compressing stored attachments is only on the archive PC.');
  const kind = compressibleAs(a);
  if (!kind) return { kind: 'skipped', reason: 'unsupported' };
  try {
    opts.onProgress?.(0);
    const response = await fetch(attachmentUrl(a), { signal: opts.signal });
    if (!response.ok) throw new Error(`Couldn't read the stored attachment (${response.status}).`);
    // The source Blob retains the whole file; videoEncodeOutput streams encoded Blob parts without a second full ArrayBuffer.
    const original = await response.blob();
    opts.signal?.throwIfAborted();
    const file = new File([original], a.filename, { type: mediaType(a) ?? original.type });
    const encoded = kind === 'video'
      ? await encodeForArchive(file, { signal: opts.signal, onProgress: (fraction) => opts.onProgress?.(fraction * ARCHIVE_ENCODE_PROGRESS_SHARE) })
      : await encodeImageForArchive(file, { signal: opts.signal });
    opts.signal?.throwIfAborted();
    if (encoded.kind === 'unsupported') return { kind: 'skipped', reason: 'unsupported' };
    if (encoded.kind === 'skipped' || !savesEnough(original.size, encoded.file.size)) return { kind: 'skipped', reason: 'not-smaller' };
    opts.onProgress?.(ARCHIVE_ENCODE_PROGRESS_SHARE);
    return await replace(a.id, REPLACEMENT_FORMAT[kind], encoded.file, opts);
  } catch (err) {
    opts.signal?.throwIfAborted();
    throw err;
  }
}

async function replace(id: string, ext: ReplacementExt, file: Blob, opts: CompressOptions): Promise<CompressOutcome> {
  opts.signal?.throwIfAborted();
  const { token } = await api.media.beginReplacement(id, ext);
  try {
    for (let offset = 0; offset < file.size; offset += UPLOAD_CHUNK_BYTES) {
      opts.signal?.throwIfAborted();
      const bytes = new Uint8Array(await file.slice(offset, offset + UPLOAD_CHUNK_BYTES).arrayBuffer());
      opts.signal?.throwIfAborted();
      await api.media.replacementChunk(token, offset, bytes);
      opts.onProgress?.(ARCHIVE_ENCODE_PROGRESS_SHARE + (1 - ARCHIVE_ENCODE_PROGRESS_SHARE) * Math.min(offset + bytes.length, file.size) / file.size);
    }
    opts.signal?.throwIfAborted();
    // Once finish reaches core, cancellation cannot undo its commit.
    const { savedBytes } = await api.media.finishReplacement(token);
    opts.signal?.throwIfAborted();
    opts.onProgress?.(1);
    return { kind: 'compressed', savedBytes };
  } catch (err) {
    await api.media.abortReplacement(token).catch(() => undefined);
    opts.signal?.throwIfAborted();
    throw err;
  }
}

/** Deletes stored files while retaining their evicted rows. */
export async function freeStored(ids: readonly string[]): Promise<FreeResult> {
  const result: FreeResult = { freed: 0, bytes: 0 };
  const unique = [...new Set(ids)];
  for (let offset = 0; offset < unique.length; offset += FREE_ATTACHMENTS_MAX) {
    const batch = await api.core.freeAttachments(unique.slice(offset, offset + FREE_ATTACHMENTS_MAX));
    result.freed += batch.freed;
    result.bytes += batch.bytes;
  }
  return result;
}
