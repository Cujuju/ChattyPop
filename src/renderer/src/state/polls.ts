// The owner's votes on Discord polls.
import { api } from '@/api';
import type { ArchiveMessage } from '@shared/contract';
import type { ArchivePoll } from '@shared/polls';
import { errorText } from '@/ui/format';
import { refreshLoaded } from './archive';

/** Voting is open: the message stands, Discord hasn't closed the poll, and its end hasn't passed by `now`. */
export const pollOpen = (m: ArchiveMessage, poll: ArchivePoll, now: number): boolean =>
  m.deletedAt === null && !poll.finalized && (poll.expiresAt === null || poll.expiresAt > now);

/** Sets the owner's vote to `answerIds` (none takes it back); main applies it to the archive before resolving. */
export async function votePoll(m: ArchiveMessage, answerIds: number[]): Promise<void> {
  try {
    await api.discord.votePoll({ channelId: m.channelId, messageId: m.id, answerIds });
    await refreshLoaded([m.id]);
  } catch (err) {
    throw new Error(`Couldn't ${answerIds.length ? 'vote' : 'remove the vote'}: ${errorText(err)}`);
  }
}
