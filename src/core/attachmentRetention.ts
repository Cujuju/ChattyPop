import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { attachmentFileName, attachmentShard, type StoredFile } from '@shared/media';
import { BYTES_PER_GB } from '@shared/units';
import { getSetting, setSetting, type Db } from './db';

/** Newest message time among pruned files: attachments at or before it aren't downloaded (they'd be pruned at once). */
const PRUNED_BEFORE_KEY = 'archive.attachmentsPrunedBefore';

type StoredRow = StoredFile & { bytes: number | null; ts: number };

/** Each stored content's disk use, oldest newest-message first: its size times the extension copies its rows name (archives from before one file per hash may hold several). */
function storedContents(rows: readonly StoredRow[]): { sha: string; bytes: number; newest: number }[] {
  const bySha = new Map<string, { names: Set<string>; size: number; newest: number }>();
  for (const r of rows) {
    const c = bySha.get(r.sha256) ?? { names: new Set<string>(), size: 0, newest: r.ts };
    bySha.set(r.sha256, c);
    c.names.add(attachmentFileName(r));
    c.size = Math.max(c.size, r.bytes ?? 0);
    c.newest = Math.max(c.newest, r.ts);
  }
  return [...bySha].map(([sha, c]) => ({ sha, bytes: c.size * c.names.size, newest: c.newest })).sort((a, b) => a.newest - b.newest);
}

/** Evicts files by their newest referencing message until under cap. Retains attachment rows as evicted and returns bytes freed. */
export function enforceAttachmentCap(db: Db, attachmentsDir: string, capGb: number | null, changed: (attachmentId: string) => void = () => {}): number {
  if (capGb === null) return 0;
  const cap = capGb * BYTES_PER_GB;
  const rows = db
    .prepare(
      `SELECT a.sha256, a.filename, a.stored_ext AS storedExt, a.stored_bytes AS bytes, m.ts
       FROM attachments a JOIN messages m ON m.id = a.message_id WHERE a.status = 'stored'`,
    )
    .all() as StoredRow[];
  const files = storedContents(rows);
  let total = files.reduce((n, f) => n + f.bytes, 0);
  if (total <= cap) return 0;
  const evict = db.prepare("UPDATE attachments SET status = 'evicted', error = NULL WHERE sha256 = ? RETURNING id").pluck();
  let freed = 0;
  let prunedBefore = Number(getSetting(db, PRUNED_BEFORE_KEY)) || 0;
  for (const f of files) {
    if (total <= cap) break;
    const affected = evict.all(f.sha) as string[];
    removeStoredFiles(attachmentsDir, f.sha);
    affected.forEach(changed);
    total -= f.bytes;
    freed += f.bytes;
    prunedBefore = Math.max(prunedBefore, f.newest);
  }
  setSetting(db, PRUNED_BEFORE_KEY, prunedBefore);
  return freed;
}

/** Pending attachments on messages at or before the pruning frontier are marked evicted instead of downloaded. */
export function skipPrunedPending(db: Db): string[] {
  const before = Number(getSetting(db, PRUNED_BEFORE_KEY)) || 0;
  if (!before) return [];
  return db.prepare(
    `UPDATE attachments SET status = 'evicted' WHERE status = 'pending'
       AND message_id IN (SELECT id FROM messages WHERE ts <= ?) RETURNING id`,
  ).pluck().all(before) as string[];
}

/** Where an archived attachment is stored: <shard>/<sha>.<ext> under the attachments folder. */
export const storedAttachmentPath = (attachmentsDir: string, f: StoredFile): string =>
  join(attachmentsDir, attachmentShard(f.sha256), attachmentFileName(f));

/** Removes every stored copy of `sha` (older archives may hold it under several extensions) except the names in `keep`. Returns bytes removed. */
export function removeStoredFiles(attachmentsDir: string, sha: string, keep: ReadonlySet<string> = new Set()): number {
  const shard = join(attachmentsDir, attachmentShard(sha));
  if (!existsSync(shard)) return 0;
  let bytes = 0;
  for (const name of readdirSync(shard)) {
    if (!name.startsWith(`${sha}.`) || keep.has(name)) continue;
    const path = join(shard, name);
    const size = statSync(path).size;
    rmSync(path, { force: true });
    bytes += size;
  }
  return bytes;
}
