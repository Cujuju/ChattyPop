// Accepted rows stay outside pagination: an unarchived id cannot be a database paging cursor.
import { createSignal } from 'solid-js';
import type { ArchiveMessage } from '@shared/contract';
import type { PostedOwnerMessage } from '@shared/compose';
import { postedArchiveMessage } from '@shared/postedMessage';
import { messageBefore } from '@shared/messageOrder';

export function createSentRows() {
  const [sent, setSent] = createSignal<ArchiveMessage[]>([]);
  const [archived, setArchived] = createSignal<readonly ArchiveMessage[]>([]);

  function accept(result: PostedOwnerMessage): void {
    const m = postedArchiveMessage(result.message, result.nonce);
    if (archived().some((row) => row.id === m.id || row.nonce === result.nonce)) return;
    setSent((rows) => [...rows.filter((row) => row.id !== m.id && row.nonce !== result.nonce), m]);
  }

  /** Archived copies win by id or nonce, including when the gateway beats the send response. */
  function reconcile(rows: readonly ArchiveMessage[]): void {
    setArchived(rows);
    setSent((pending) => pending.filter((m) => !rows.some((row) => row.id === m.id || (row.nonce && row.nonce === m.nonce))));
  }

  function merge(channelId: string | null, rows: readonly ArchiveMessage[]): ArchiveMessage[] {
    const extra = sent().filter((m) => m.channelId === channelId && !rows.some((row) => row.id === m.id || (row.nonce && row.nonce === m.nonce)));
    if (!extra.length) return rows as ArchiveMessage[];
    return [...rows, ...extra.map((m) => {
      const author = [...rows].reverse().find((row) => row.author.id === m.author.id)?.author ?? m.author;
      const replied = rows.find((row) => row.id === m.replyToId);
      return { ...m, author, reply: replied ? {
        messageId: replied.id, authorId: replied.author.id, authorName: replied.author.name,
        authorColor: replied.author.color, avatar: replied.author.avatar, content: replied.content, mentions: replied.mentions,
      } : m.reply };
    })].sort((a, b) => messageBefore(a, b) ? -1 : messageBefore(b, a) ? 1 : 0);
  }

  const hasArchived = (nonce: string): boolean => archived().some((m) => m.nonce === nonce);
  return { accept, reconcile, merge, hasArchived };
}

export const sentRows = createSentRows();
