import type { ArchiveMessage } from '@shared/contract';
import { MS_PER_MIN } from '@shared/units';

/** Consecutive messages from one author within this gap share one avatar and name in cozy layout. */
export const GROUP_GAP_MS = 7 * MS_PER_MIN;

type GroupMessage = Pick<ArchiveMessage, 'author' | 'ts' | 'replyToId'>;

/** Messages share a header only within one day, from the same author, close together, and without a new reply. */
export function canGroupMessage(previous: GroupMessage | undefined, message: GroupMessage): boolean {
  return previous !== undefined && previous.author.id === message.author.id && message.ts - previous.ts < GROUP_GAP_MS
    && message.replyToId === null && new Date(previous.ts).toDateString() === new Date(message.ts).toDateString();
}
