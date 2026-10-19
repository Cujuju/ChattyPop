import type { ArchiveEmoji, MessagePageQuery, MessageWindow } from '@shared/contract';
import type { UsedEmoji } from '@shared/compose';
import type { UsedCommand } from '@shared/commands';
import type { SavedChannelAccess } from '@shared/savedMessages';
import type { SyncState } from '@shared/contract';
import type { Db } from '../db';
import { archiveReadFence, readHost } from '../reads/archiveReads';
import { decorateMessagesAsync, type MessageSnapshot } from './messageDecorations';

/** Interactive host reads use the same cancellable helper lane as visible plugin reads. */
export const ownReactionsAsync = (db: Db, limit: number, signal?: AbortSignal): Promise<ArchiveEmoji[]> =>
  readHost(db, { kind: 'ownReactions', limit }, signal, 'interactive');

export const ownEmojiAsync = (db: Db, authorId: string, limit: number, signal?: AbortSignal): Promise<UsedEmoji[]> =>
  readHost(db, { kind: 'ownEmoji', authorId, limit }, signal, 'interactive');

export const ownCommandsAsync = (db: Db, userId: string, limit: number, signal?: AbortSignal): Promise<UsedCommand[]> =>
  readHost(db, { kind: 'ownCommands', userId, limit }, signal, 'interactive');

export const savedWritableChannelsAsync = (db: Db, accountId: string, signal?: AbortSignal): Promise<SavedChannelAccess[]> =>
  readHost(db, { kind: 'savedWritableChannels', accountId }, signal, 'interactive');

export async function syncStateAsync(db: Db, channelId: string, signal?: AbortSignal): Promise<SyncState> {
  const [state] = await readHost<SyncState>(db, { kind: 'syncState', channelId }, signal, 'interactive');
  return state!;
}

export async function messagePageAsync(db: Db, query: MessagePageQuery, signal?: AbortSignal) {
  const fence = archiveReadFence(db);
  const [snapshot] = await readHost<MessageSnapshot>(db, { kind: 'messagePage', query }, signal, 'interactive');
  signal?.throwIfAborted();
  return decorateMessagesAsync(snapshot!, () => { signal?.throwIfAborted(); fence(); return true; });
}

export async function messageWindowAsync(db: Db, query: MessagePageQuery, signal?: AbortSignal): Promise<MessageWindow> {
  const fence = archiveReadFence(db);
  const [result] = await readHost<{ snapshot: MessageSnapshot; reachesNewest: boolean }>(db, { kind: 'messageWindow', query }, signal, 'interactive');
  signal?.throwIfAborted();
  return { items: await decorateMessagesAsync(result!.snapshot, () => { signal?.throwIfAborted(); fence(); return true; }), reachesNewest: result!.reachesNewest };
}
