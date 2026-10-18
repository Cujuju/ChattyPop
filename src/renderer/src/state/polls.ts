// The owner's votes on Discord polls, and the poll whose voters View votes shows.
import { createSignal } from 'solid-js';
import { api } from '@/api';
import type { ArchiveMessage, PersonMatch } from '@shared/contract';
import type { ArchivePoll, PollVoters } from '@shared/polls';
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

/** A poll View votes shows: its message, and its question and answers as they were when it opened. */
export interface PollVotesOf {
  channelId: string;
  messageId: string;
  question: string;
  answers: Pick<ArchivePoll['answers'][number], 'id' | 'text' | 'emoji' | 'votes'>[];
}

const [votesOf, setVotesOf] = createSignal<PollVotesOf | null>(null);
export const pollVotesOf = votesOf;

/** Shows who voted on `m`'s poll. Plain copies: the message is a store proxy, which IPC can't clone. */
export const openPollVotes = (m: ArchiveMessage, poll: ArchivePoll): void =>
  void setVotesOf({
    channelId: m.channelId,
    messageId: m.id,
    question: poll.question,
    answers: poll.answers.map((a) => ({ id: a.id, text: a.text, emoji: a.emoji && { ...a.emoji }, votes: a.votes })),
  });
export const closePollVotes = (): void => void setVotesOf(null);

/** A page of who voted for `answerId`, after voter `after` (null: the first page), fetched from Discord now. */
export async function pollVotersPage(p: PollVotesOf, answerId: number, after: string | null): Promise<PollVoters> {
  try {
    return await api.discord.pollVoters(p.channelId, p.messageId, answerId, after);
  } catch (err) {
    throw new Error(`Couldn't load the votes: ${errorText(err)}`);
  }
}

/** Answers whose first voters hover tips keep; past it the oldest is dropped. */
const VOTER_TIPS_KEPT = 50;
const tipVoters = new Map<string, { votes: number; people: Promise<PersonMatch[]> }>();

/** The first voters for an answer's hover tip, fetched once while its count holds: a vote changes the count. */
export function answerTipVoters(m: ArchiveMessage, answerId: number, votes: number): Promise<PersonMatch[]> {
  const key = `${m.id}:${answerId}`;
  const kept = tipVoters.get(key);
  if (kept?.votes === votes) return kept.people;
  const people = api.discord.pollVoters(m.channelId, m.id, answerId, null).then((page) => page.people);
  tipVoters.delete(key);
  tipVoters.set(key, { votes, people });
  if (tipVoters.size > VOTER_TIPS_KEPT) tipVoters.delete(tipVoters.keys().next().value!);
  // A failed fetch isn't kept: the next hover asks again.
  people.catch(() => tipVoters.get(key)?.people === people && tipVoters.delete(key));
  return people;
}
