import type { NoteArchiveChange } from '@shared/archiveChanges';
import type { ArchiveChangeKind } from '@shared/contract';
import type { Db } from './db';

/** ISO dates use the first ten characters of an ISO timestamp. */
const ISO_DAY_LENGTH = 10;
export const utcDay = (ts: number): string => new Date(ts).toISOString().slice(0, ISO_DAY_LENGTH);

/** Existing-row mutations retain their actual UTC partitions for subsequent rollup invalidation. */
export function noteMessageChanges(db: Db, changed: NoteArchiveChange, channelId: string, kinds: readonly ArchiveChangeKind[], ids: readonly string[]): void {
  const rows = db.prepare('SELECT DISTINCT ts FROM messages WHERE channel_id = ? AND id IN (SELECT value FROM json_each(?))')
    .all(channelId, JSON.stringify(ids)) as { ts: number }[];
  if (!rows.length) return;
  for (const row of rows) changed(channelId, kinds, { day: utcDay(row.ts) });
}

/** Download and stored-file changes invalidate the attachment's channel and its UTC partition. */
export function noteAttachmentChange(db: Db, changed: NoteArchiveChange, id: string, disk: boolean): void {
  const row = db.prepare('SELECT channel_id AS channelId, ts FROM attachments WHERE id = ?').get(id) as { channelId: string; ts: number } | undefined;
  if (row) changed(row.channelId, disk ? ['attachments', 'disk'] : ['attachments'], { day: utcDay(row.ts) });
}

/** Message presentation fields whose changes invalidate stored message snapshots. */
const EDIT_FIELDS = ['content', 'embeds', 'flags', 'components', 'sticker_items', 'message_reference', 'referenced_message', 'edited_timestamp', 'pinned'] as const;

/** Payload deltas keep reaction and poll snapshots from invalidating unrelated media readers during sync. */
export function messageChangeKinds(before: object | null, after: object, derived: readonly ArchiveChangeKind[]): ArchiveChangeKind[] {
  if (!before) {
    const inserted: ArchiveChangeKind[] = ['messages', ...derived];
    const payload = after as Record<string, unknown>;
    if (Array.isArray(payload.reactions) && payload.reactions.length) inserted.push('reactions');
    if (payload.poll) inserted.push('polls');
    return inserted;
  }
  const previous = before as Record<string, unknown>, next = after as Record<string, unknown>;
  const differs = (field: string): boolean => JSON.stringify(previous[field]) !== JSON.stringify(next[field]);
  const kinds: ArchiveChangeKind[] = [];
  if (EDIT_FIELDS.some(differs)) kinds.push('edits');
  if (differs('reactions')) kinds.push('reactions');
  if (differs('poll')) kinds.push('polls');
  if (differs('attachments') && derived.includes('attachments')) kinds.push('attachments');
  if ((differs('content') || differs('embeds')) && derived.includes('links')) kinds.push('links');
  return kinds;
}
