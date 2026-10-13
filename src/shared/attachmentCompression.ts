import { fileExt, mediaKind, mediaType, type StoredFile } from './media';

export type CompressAs = 'video' | 'image';
interface CompressionCandidate extends StoredFile {
  status: string;
  contentType: string | null;
  animated: boolean;
  compressed: boolean;
  removed?: boolean;
}
const IMAGE_EXTS_NOT_REENCODED = new Set(['gif', 'svg']);
const IMAGE_TYPES_NOT_REENCODED = new Set(['image/gif', 'image/svg+xml']);

/** Compression excludes unavailable files, previous replacements, animated images and vectors. */
export function compressibleAs(a: CompressionCandidate): CompressAs | null {
  if (a.status !== 'stored' || !a.sha256 || a.compressed || a.removed) return null;
  const kind = mediaKind(a);
  if (kind === 'video') return 'video';
  if (kind !== 'image' || a.animated || IMAGE_EXTS_NOT_REENCODED.has(fileExt(a.filename)) || IMAGE_TYPES_NOT_REENCODED.has(mediaType(a) ?? '')) return null;
  return 'image';
}
