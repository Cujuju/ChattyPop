// Download queues for attachments and custom emoji; main's downloader drains them.
import type { CoreMethods, PendingAttachment, PendingEmoji } from '@shared/contract';
import { GENERIC_CONTENT_TYPE } from '@shared/media';
import { skipPrunedPending } from './attachmentRetention';
import type { Db } from './db';

/** The queues as core methods; `onStored` runs after an attachment reaches the store. */
export const mediaQueueHandlers = (
  db: () => Db,
  onStored: (attachmentId: string) => void,
): Pick<CoreMethods, 'pendingAttachments' | 'archivedVideos' | 'attachmentSource' | 'attachmentStored' | 'attachmentFailed' | 'pendingEmojis' | 'emojiDone'> => ({
  pendingAttachments: (limit) => {
    skipPrunedPending(db());
    return pendingAttachments(db(), limit);
  },
  archivedVideos: () => archivedVideos(db()),
  attachmentSource: (id) => attachmentSource(db(), id),
  attachmentStored: (id, sha256, bytes) => {
    attachmentStored(db(), id, sha256, bytes);
    onStored(id);
  },
  attachmentFailed: (id, error) => attachmentFailed(db(), id, error),
  pendingEmojis: (limit) => pendingEmojis(db(), limit),
  emojiDone: (id, error) => emojiDone(db(), id, error),
});

export function pendingAttachments(db: Db, limit: number): PendingAttachment[] {
  return db
    .prepare(
      `SELECT id, message_id AS messageId, channel_id AS channelId, url, filename, content_type AS contentType FROM attachments
       WHERE status = 'pending' ORDER BY length(message_id) DESC, message_id DESC LIMIT ?`,
    )
    .all(limit) as PendingAttachment[];
}

/** Stored attachments still on Discord that may be videos: a video type, or none that says (main reads the extension). */
export function archivedVideos(db: Db): PendingAttachment[] {
  return db
    .prepare(
      `SELECT a.id, a.message_id AS messageId, a.channel_id AS channelId, a.url, a.filename, a.content_type AS contentType FROM attachments a
       JOIN messages m ON m.id = a.message_id
       WHERE a.status = 'stored' AND a.removed_at IS NULL AND m.deleted_at IS NULL
         AND (a.content_type LIKE 'video/%' OR a.content_type IS NULL OR a.content_type = ?)`,
    )
    .all(GENERIC_CONTENT_TYPE) as PendingAttachment[];
}

/** Where an attachment is fetched from; null once it or its message left Discord. */
export function attachmentSource(db: Db, id: string): PendingAttachment | null {
  const row = db
    .prepare(
      `SELECT a.id, a.message_id AS messageId, a.channel_id AS channelId, a.url, a.filename, a.content_type AS contentType FROM attachments a
       JOIN messages m ON m.id = a.message_id WHERE a.id = ? AND a.removed_at IS NULL AND m.deleted_at IS NULL`,
    )
    .get(id) as PendingAttachment | undefined;
  return row ?? null;
}

export function attachmentStored(db: Db, id: string, sha256: string, bytes: number): void {
  db.prepare("UPDATE attachments SET status = 'stored', sha256 = ?, stored_bytes = ?, error = NULL WHERE id = ?").run(sha256, bytes, id);
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

export function attachmentFailed(db: Db, id: string, error: string): void {
  db.prepare("UPDATE attachments SET status = 'failed', error = ? WHERE id = ?").run(error, id);
}
