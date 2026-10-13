import type { StoredFile } from '../media';

/** Maximum attachments freed in one owner request. */
export const FREE_ATTACHMENTS_MAX = 1000;

export interface FreeResult {
  /** Attachments marked evicted. */
  freed: number;
  /** Bytes removed from disk. */
  bytes: number;
}

export interface ReplaceStored {
  sha256: string;
  newSha256: string;
  storedExt: string;
  bytes: number;
}

/** A stored attachment's file and re-encoding metadata. */
export interface StoredAttachmentFile extends StoredFile {
  id: string;
  contentType: string | null;
  storedBytes: number | null;
  compressedAt: number | null;
}
