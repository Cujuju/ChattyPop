// The stored message payload's two forms; apart from db.ts so migrations can read it without an import cycle.
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

/**
 * messages.raw_json holds the payload as JSON text, or (text retention) a zstd-compressed BLOB of that text. A BLOB that
 * won't decompress (damaged) reads as no payload. Text is returned as stored: parsing it is the reader's (parseRawJson, payloadSql).
 */
export const rawJsonText = (v: string | Buffer | null): string | null => {
  if (!Buffer.isBuffer(v)) return v;
  try {
    return zstdDecompressSync(v).toString('utf8');
  } catch {
    return null;
  }
};

/** A stored payload parsed; null when there is none or it is damaged. */
export const parseRawJson = <T>(v: string | Buffer | null): T | null => {
  const text = rawJsonText(v);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

export const compressRawJson =(json: string): Buffer => zstdCompressSync(json);
