import { createHash } from 'node:crypto';

/** Mutable entry points always contact the host; versioned assets stay private to this browser. */
export const REVALIDATE_ASSET = 'private, no-cache';
export const IMMUTABLE_ASSET = 'private, max-age=31536000, immutable';
export const contentTag = (body: Uint8Array | string): string => `"${createHash('sha256').update(body).digest('hex')}"`;

/** Vite's generated assets contain an eight-or-more-character content hash before the extension. */
export const HASHED_BUILD_ASSET = /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[^/]+$/;

export function assetReply(body: Uint8Array | string, type: string, immutable = false, headers: Record<string, string> = {}): Response {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body);
  return new Response(bytes, { headers: {
    ...headers,
    'content-type': type,
    'content-length': String(bytes.byteLength),
    'cache-control': immutable ? IMMUTABLE_ASSET : REVALIDATE_ASSET,
    etag: contentTag(bytes),
  } });
}
