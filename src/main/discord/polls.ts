// The owner's poll votes, sent as Discord's client sends them, and who voted for an answer, read as it reads them.
import { snowflakeArg, type RawUser } from '@shared/discord';
import { POLL_ANSWERS_MAX, POLL_VOTERS_PAGE, type OwnerPollVote } from '@shared/polls';
import type { DiscordReader, DiscordWriter } from './client';

/** `v` checked as an OwnerPollVote (it comes from the renderer); throws the reason it isn't one. */
export function checkOwnerPollVote(v: unknown): OwnerPollVote {
  const p = v as Partial<OwnerPollVote> | null;
  const ids = p?.answerIds;
  if (!p || !Array.isArray(ids) || ids.length > POLL_ANSWERS_MAX || !ids.every((id) => Number.isInteger(id) && id > 0) || new Set(ids).size !== ids.length)
    throw new Error('Not a poll vote.');
  return { channelId: snowflakeArg(p.channelId, 'channel'), messageId: snowflakeArg(p.messageId, 'message'), answerIds: [...ids] };
}

/** Sets the owner's vote to the answers chosen (none takes it back); resolves with what was applied. Discord refuses a closed poll. */
export async function votePollAsOwner(api: DiscordWriter, v: unknown): Promise<OwnerPollVote> {
  const p = checkOwnerPollVote(v);
  await api.putJson(`channels/${p.channelId}/polls/${p.messageId}/answers/@me`, { answer_ids: p.answerIds.map(String) });
  return p;
}

/**
 * A page of who voted for one answer, after voter `after` (null: from the first), and the voter the next page starts
 * after: a full page may have more, and Discord answers past the end with none. Throws for arguments that aren't one.
 */
export async function fetchPollVoters(api: DiscordReader, channelId: unknown, messageId: unknown, answerId: unknown, after: unknown): Promise<{ users: RawUser[]; next: string | null }> {
  const channel = snowflakeArg(channelId, 'channel');
  const message = snowflakeArg(messageId, 'message');
  if (!Number.isInteger(answerId) || (answerId as number) < 1) throw new Error('Not a poll answer.');
  const from = after === null ? null : snowflakeArg(after, 'user');
  const page = await api.get<{ users?: unknown }>(`channels/${channel}/polls/${message}/answers/${answerId as number}`, { limit: POLL_VOTERS_PAGE, ...(from ? { after: from } : {}) });
  if (!Array.isArray(page.users)) throw new Error('Discord returned an unexpected voter list.');
  const users = page.users as RawUser[];
  return { users, next: users.length === POLL_VOTERS_PAGE ? users[users.length - 1]!.id : null };
}
