import type { SyncState } from '@shared/contract';
import type { Db } from '../db';

/** Writer-side cursor updates do not need a count of the channel's entire history. */
export function syncCursor(db: Db, channelId: string): Omit<SyncState, 'count'> {
  const c = db.prepare('SELECT sync_oldest_id AS o, sync_newest_id AS n, backfill_complete AS done FROM channels WHERE id = ?')
    .get(channelId) as { o: string | null; n: string | null; done: number } | undefined;
  return { channelId, oldestId: c?.o ?? null, newestId: c?.n ?? null, backfillComplete: c?.done === 1 };
}

export function syncState(db: Db, channelId: string): SyncState {
  const count = db.prepare('SELECT COUNT(*) FROM messages WHERE channel_id = ?').pluck().get(channelId) as number;
  return { ...syncCursor(db, channelId), count };
}
