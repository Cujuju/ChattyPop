import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { attachmentFileName, attachmentShard } from '@shared/media';
import { BYTES_PER_GB } from '@shared/units';
import { getSetting, setSetting, type Db } from './db';

/** Newest message time among pruned files: attachments at or before it aren't downloaded (they'd be pruned at once). */
const PRUNED_BEFORE_KEY = 'archive.attachmentsPrunedBefore';

/**
 * Keeps the attachment store under the cap by deleting the oldest files first. "Oldest" is by the newest message
 * that uses a file, since identical files are stored once. Rows stay, marked 'evicted', so messages still show
 * what was attached. Returns the bytes freed.
 */
export function enforceAttachmentCap(db: Db, attachmentsDir: string, capGb: number | null): number {
  if (capGb === null) return 0;
  const cap = capGb * BYTES_PER_GB;
  const files = db
    .prepare(
      `SELECT a.sha256 AS sha, MAX(a.stored_bytes) AS bytes, MAX(m.ts) AS newest
       FROM attachments a JOIN messages m ON m.id = a.message_id
       WHERE a.status = 'stored' GROUP BY a.sha256 ORDER BY newest ASC`,
    )
    .all() as { sha: string; bytes: number | null; newest: number }[];
  let total = files.reduce((n, f) => n + (f.bytes ?? 0), 0);
  if (total <= cap) return 0;
  const evict = db.prepare("UPDATE attachments SET status = 'evicted', error = NULL WHERE sha256 = ?");
  let freed = 0;
  let prunedBefore = Number(getSetting(db, PRUNED_BEFORE_KEY)) || 0;
  for (const f of files) {
    if (total <= cap) break;
    removeStoredFiles(attachmentsDir, f.sha);
    evict.run(f.sha);
    total -= f.bytes ?? 0;
    freed += f.bytes ?? 0;
    prunedBefore = Math.max(prunedBefore, f.newest);
  }
  setSetting(db, PRUNED_BEFORE_KEY, prunedBefore);
  return freed;
}

/** Pending attachments on messages at or before the pruning frontier are marked evicted instead of downloaded. */
export function skipPrunedPending(db: Db): void {
  const before = Number(getSetting(db, PRUNED_BEFORE_KEY)) || 0;
  if (!before) return;
  db.prepare(
    `UPDATE attachments SET status = 'evicted' WHERE status = 'pending'
       AND message_id IN (SELECT id FROM messages WHERE ts <= ?)`,
  ).run(before);
}

/** Where an archived attachment is stored: <shard>/<sha>.<ext> under the attachments folder. */
export const storedAttachmentPath = (attachmentsDir: string, sha256: string, filename: string): string =>
  join(attachmentsDir, attachmentShard(sha256), attachmentFileName(sha256, filename));

/** The same content may exist under more than one extension, so every stored copy of `sha` is removed. */
function removeStoredFiles(attachmentsDir: string, sha: string): void {
  const shard = join(attachmentsDir, attachmentShard(sha));
  if (!existsSync(shard)) return;
  for (const name of readdirSync(shard)) if (name.startsWith(`${sha}.`)) rmSync(join(shard, name), { force: true });
}
