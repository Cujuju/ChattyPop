import type { ArchiveEmoji, MessagePageQuery, MessageWindow } from '@shared/contract';
import type { UsedEmoji } from '@shared/compose';
import type { Db } from '../db';
import { readHost } from '../reads/archiveReads';
import { decorateMessages, type MessageSnapshot } from './messageDecorations';

/** Interactive host reads use the same cancellable helper lane as visible plugin reads. */
export const ownReactionsAsync = (db: Db, limit: number, signal?: AbortSignal): Promise<ArchiveEmoji[]> =>
  readHost(db, { kind: 'ownReactions', limit }, signal, 'interactive');

export const ownEmojiAsync = (db: Db, authorId: string, limit: number, signal?: AbortSignal): Promise<UsedEmoji[]> =>
  readHost(db, { kind: 'ownEmoji', authorId, limit }, signal, 'interactive');

export async function messagePageAsync(db: Db, query: MessagePageQuery, signal?: AbortSignal) {
  const [snapshot] = await readHost<MessageSnapshot>(db, { kind: 'messagePage', query }, signal, 'interactive');
  signal?.throwIfAborted();
  return decorateMessages(snapshot!);
}

export async function messageWindowAsync(db: Db, query: MessagePageQuery, signal?: AbortSignal): Promise<MessageWindow> {
  const [result] = await readHost<{ snapshot: MessageSnapshot; reachesNewest: boolean }>(db, { kind: 'messageWindow', query }, signal, 'interactive');
  signal?.throwIfAborted();
  return { items: decorateMessages(result!.snapshot), reachesNewest: result!.reachesNewest };
}
