import { statSync } from 'node:fs';
import { SHA256_HEX, SAFE_EXT, attachmentFileName, type StoredFile } from '@shared/media';
import type { FreeResult, ReplaceStored, StoredAttachmentFile } from '@shared/types/attachmentStore';
import { removeStoredFiles, storedAttachmentPath } from './attachmentRetention';
import type { Db } from './db';

export type { FreeResult, ReplaceStored } from '@shared/types/attachmentStore';

/** Marks stored attachments evicted, then removes their content's files no stored row names. Unknown or unstored ids are skipped. */
export function freeAttachments(db: Db, attachmentsDir: string, ids: readonly string[]): FreeResult & { channelIds: string[] } {
  const rows = db.transaction(() => {
    const stored = db.prepare(`SELECT id, sha256, channel_id AS channelId FROM attachments
      WHERE status = 'stored' AND sha256 IS NOT NULL AND id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(ids)) as { id: string; sha256: string; channelId: string }[];
    const evict = db.prepare("UPDATE attachments SET status = 'evicted', error = NULL WHERE id = ?");
    for (const row of stored) evict.run(row.id);
    return stored;
  })();
  const stillStored = db.prepare("SELECT sha256, filename, stored_ext AS storedExt FROM attachments WHERE sha256 = ? AND status = 'stored'");
  let bytes = 0;
  for (const sha of new Set(rows.map((row) => row.sha256))) {
    const named = new Set((stillStored.all(sha) as StoredFile[]).map(attachmentFileName));
    bytes += removeStoredFiles(attachmentsDir, sha, named);
  }
  return { freed: rows.length, bytes, channelIds: [...new Set(rows.map((row) => row.channelId))] };
}

/** Repoints all stored references to a smaller existing re-encode before removing the old content's files. */
export function replaceStoredFile(db: Db, attachmentsDir: string, r: ReplaceStored, now: number): { savedBytes: number; channelIds: string[] } {
  if (!r || typeof r.sha256 !== 'string' || !SHA256_HEX.test(r.sha256)
    || typeof r.newSha256 !== 'string' || !SHA256_HEX.test(r.newSha256) || r.sha256 === r.newSha256
    || typeof r.storedExt !== 'string' || !SAFE_EXT.test(r.storedExt)
    || !Number.isSafeInteger(r.bytes) || r.bytes < 0 || !Number.isSafeInteger(now) || now < 0)
    throw new Error('Not a stored re-encode.');
  const file = { sha256: r.newSha256, filename: '', storedExt: r.storedExt };
  const stat = statSync(storedAttachmentPath(attachmentsDir, file), { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size !== r.bytes) throw new Error('The re-encoded file is missing or its size differs.');
  const result = db.transaction(() => {
    const rows = db.prepare(`SELECT stored_bytes AS bytes, channel_id AS channelId FROM attachments
      WHERE sha256 = ? AND status = 'stored'`).all(r.sha256) as { bytes: number | null; channelId: string }[];
    if (!rows.length || rows.some((row) => row.bytes === null || r.bytes >= row.bytes))
      throw new Error('The re-encode must be smaller than every stored reference.');
    db.prepare(`UPDATE attachments SET sha256 = ?, stored_ext = ?, stored_bytes = ?, compressed_at = ?
      WHERE sha256 = ? AND status = 'stored'`).run(r.newSha256, r.storedExt, r.bytes, now, r.sha256);
    return { savedBytes: rows.reduce((max, row) => Math.max(max, row.bytes!), 0) - r.bytes, channelIds: [...new Set(rows.map((row) => row.channelId))] };
  })();
  removeStoredFiles(attachmentsDir, r.sha256);
  return result;
}

/** What main needs to re-encode one attachment's file: null unless stored. */
export function storedFileOf(db: Db, id: string): StoredAttachmentFile | null {
  return db.prepare(`SELECT id, sha256, filename, stored_ext AS storedExt, content_type AS contentType,
    stored_bytes AS storedBytes, compressed_at AS compressedAt FROM attachments
    WHERE id = ? AND status = 'stored' AND sha256 IS NOT NULL`).get(id) as StoredAttachmentFile | undefined ?? null;
}
