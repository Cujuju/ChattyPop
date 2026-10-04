// The stored message payload's two forms; apart from db.ts so migrations can read it without an import cycle.
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

/** messages.raw_json holds the payload as JSON text, or (text retention) a zstd-compressed BLOB of that text. */
export const rawJsonText = (v: string | Buffer | null): string | null => (Buffer.isBuffer(v) ? zstdDecompressSync(v).toString('utf8') : v);
export const compressRawJson = (json: string): Buffer => zstdCompressSync(json);
