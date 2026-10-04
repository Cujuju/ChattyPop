// Download queues for attachments and custom emoji; main's downloader drains them.
import type { CoreMethods, PendingAttachment, PendingEmoji } from '@shared/contract';
import { skipPrunedPending } from './attachmentRetention';
import type { Db } from './db';

/** The queues as core methods; `onStored` runs after an attachment reaches the store. */
export const mediaQueueHandlers = (
  db: () => Db,
  onStored: (attachmentId: string) => void,
): Pick<CoreMethods, 'pendingAttachments' | 'attachmentStored' | 'attachmentFailed' | 'pendingEmojis' | 'emojiDone'> => ({
  pendingAttachments: (limit) => {
    skipPrunedPending(db());
    return pendingAttachments(db(), limit);
  },
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
      `SELECT id, message_id AS messageId, channel_id AS channelId, url, filename FROM attachments
       WHERE status = 'pending' ORDER BY length(message_id) DESC, message_id DESC LIMIT ?`,
    )
    .all(limit) as PendingAttachment[];
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
