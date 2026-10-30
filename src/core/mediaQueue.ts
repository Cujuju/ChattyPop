// Download queues for attachments and custom emoji; main's downloader drains them.
import type { NoteArchiveChange } from '@shared/archiveChanges';
import { noteAttachmentChange } from './archiveChangeSource';
import type { AttachmentSource, CoreMethods, PendingAttachment, PendingEmoji } from '@shared/contract';
import { statSync } from 'node:fs';
import { GENERIC_CONTENT_TYPE, SAFE_EXT, SHA256_HEX } from '@shared/media';
import { MS_PER_MIN } from '@shared/units';
import { skipPrunedPending, storedAttachmentPath } from './attachmentRetention';
import type { Db } from './db';

/** The queues as core methods; `onStored` runs after an attachment reaches the store (`attachmentsDir`). */
export const mediaQueueHandlers = (
  db: () => Db,
  attachmentsDir: () => string,
  onStored: (attachmentId: string) => void,
  changed: NoteArchiveChange = () => {},
): Pick<CoreMethods, 'pendingAttachments' | 'archivedVideos' | 'attachmentSource' | 'messageExists' | 'attachmentStored' | 'attachmentFailed' | 'nextAttachmentRetry' | 'pendingEmojis' | 'emojiDone'> => ({
  pendingAttachments: (limit) => {
    [...skipPrunedPending(db()), ...failRemovedPending(db())].forEach((id) => noteAttachmentChange(db(), changed, id, false));
    return pendingAttachments(db(), limit);
  },
  archivedVideos: () => archivedVideos(db()),
  attachmentSource: (id) => attachmentSource(db(), id),
  messageExists: (id) => db().prepare('SELECT 1 FROM messages WHERE id = ?').get(id) !== undefined,
  attachmentStored: (id, sha256, bytes, storedExt) => {
    attachmentStored(db(), attachmentsDir(), id, sha256, bytes, storedExt);
    noteAttachmentChange(db(), changed, id, true);
    onStored(id);
  },
  attachmentFailed: (id, error, retryable) => { attachmentFailed(db(), id, error, retryable); noteAttachmentChange(db(), changed, id, false); },
  nextAttachmentRetry: () => nextAttachmentRetry(db()),
  pendingEmojis: (limit) => pendingEmojis(db(), limit),
  emojiDone: (id, error) => emojiDone(db(), id, error),
});

/** A failed download's first retry waits this long: a dropped connection or CDN hiccup usually clears within a minute. */
const DOWNLOAD_RETRY_BASE_MS = MS_PER_MIN;
/** Each retry waits twice the last; 11 retries span about 34 hours (2^11 - 1 minutes), outlasting a night or a day offline. */
export const DOWNLOAD_RETRIES_MAX = 11;
/** The wait before retry `attempt` (1-based). */
export const downloadRetryDelayMs = (attempt: number): number => DOWNLOAD_RETRY_BASE_MS * 2 ** (attempt - 1);

/** Queued downloads: pending and still on their message (an edit's removal leaves Discord without the file). */
const QUEUED_SQL = "status = 'pending' AND removed_at IS NULL";

/** The error a queued download fails with once an edit removed its attachment. */
export const REMOVED_BEFORE_DOWNLOAD = 'Removed from its message on Discord before it was downloaded.';

/** Fails pending downloads whose attachment an edit removed, so none shows as downloading; returns their ids. */
export function failRemovedPending(db: Db): string[] {
  return db.prepare("UPDATE attachments SET status = 'failed', error = ?, retry_at = NULL WHERE status = 'pending' AND removed_at IS NOT NULL RETURNING id")
    .pluck().all(REMOVED_BEFORE_DOWNLOAD) as string[];
}

/** Downloads due by `now`, newest message first; those waiting out a retry delay are left for later. */
export function pendingAttachments(db: Db, limit: number, now = Date.now()): PendingAttachment[] {
  return db
    .prepare(
      `SELECT id, message_id AS messageId, channel_id AS channelId, url, filename, content_type AS contentType,
         (SELECT arrived_via FROM messages WHERE messages.id = attachments.message_id) AS arrivedVia FROM attachments
       WHERE ${QUEUED_SQL} AND (retry_at IS NULL OR retry_at <= ?) ORDER BY length(message_id) DESC, message_id DESC LIMIT ?`,
    )
    .all(now, limit) as PendingAttachment[];
}

/** When the earliest delayed retry is due; null when none waits. */
export function nextAttachmentRetry(db: Db): number | null {
  return db.prepare(`SELECT MIN(retry_at) FROM attachments WHERE ${QUEUED_SQL}`).pluck().get() as number | null;
}

/** Stored attachments still on Discord that may be videos: a video type, or none that says (main reads the extension). */
export function archivedVideos(db: Db): PendingAttachment[] {
  return db
    .prepare(
      `SELECT a.id, a.message_id AS messageId, a.channel_id AS channelId, a.url, a.filename, a.content_type AS contentType, m.arrived_via AS arrivedVia FROM attachments a
       JOIN messages m ON m.id = a.message_id
       WHERE a.status = 'stored' AND a.removed_at IS NULL AND m.deleted_at IS NULL
         AND (a.content_type LIKE 'video/%' OR a.content_type IS NULL OR a.content_type = ?)`,
    )
    .all(GENERIC_CONTENT_TYPE) as PendingAttachment[];
}

/** Where an attachment is fetched from; null once it or its message left Discord. */
export function attachmentSource(db: Db, id: string): AttachmentSource | null {
  const row = db
    .prepare(
      `SELECT a.id, a.message_id AS messageId, a.channel_id AS channelId, a.url, a.filename, a.content_type AS contentType, a.status FROM attachments a
       JOIN messages m ON m.id = a.message_id WHERE a.id = ? AND a.removed_at IS NULL AND m.deleted_at IS NULL`,
    )
    .get(id) as AttachmentSource | undefined;
  return row ?? null;
}

/**
 * Records a download main stored. Core removes stored files only after their rows leave 'stored', so a file checked here
 * stays while its row is stored. A file removed since main found it throws; main retries the download.
 */
export function attachmentStored(db: Db, attachmentsDir: string, id: string, sha256: string, bytes: number, storedExt: string | null = null): void {
  if (storedExt !== null && (typeof storedExt !== 'string' || !SAFE_EXT.test(storedExt))) throw new Error('Not a stored file extension.');
  if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) throw new Error('Not a stored file hash.');
  const filename = db.prepare('SELECT filename FROM attachments WHERE id = ?').pluck().get(id) as string | undefined;
  if (filename === undefined) return;
  if (!statSync(storedAttachmentPath(attachmentsDir, { sha256, filename, storedExt }), { throwIfNoEntry: false })?.isFile())
    throw new Error('The stored file is gone; the download will run again.');
  db.prepare("UPDATE attachments SET status = 'stored', sha256 = ?, stored_ext = ?, compressed_at = NULL, stored_bytes = ?, error = NULL WHERE id = ?")
    .run(sha256, storedExt, bytes, id);
}

export function pendingEmojis(db: Db, limit: number): PendingEmoji[] {
  return (db.prepare("SELECT id, animated FROM emojis WHERE status = 'pending' LIMIT ?").all(limit) as { id: string; animated: number }[]).map((e) => ({
    id: e.id,
    animated: e.animated === 1,
  }));
}

export function emojiDone(db: Db, id: string, error: string | null): void {
  db.prepare('UPDATE emojis SET status = ?, error = ? WHERE id = ?').run(error ? 'failed' : 'stored', error, id);
}

/** A `retryable` failure stays queued until its retry is due, within DOWNLOAD_RETRIES_MAX; any other, or the last, fails. */
export function attachmentFailed(db: Db, id: string, error: string, retryable: boolean, now = Date.now()): void {
  const attempts = ((db.prepare('SELECT attempts FROM attachments WHERE id = ?').pluck().get(id) as number | undefined) ?? 0) + 1;
  const retryAt = retryable && attempts <= DOWNLOAD_RETRIES_MAX ? now + downloadRetryDelayMs(attempts) : null;
  db.prepare('UPDATE attachments SET status = ?, error = ?, attempts = ?, retry_at = ? WHERE id = ?')
    .run(retryAt === null ? 'failed' : 'pending', error, attempts, retryAt, id);
}
