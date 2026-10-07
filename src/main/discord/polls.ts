// The owner's poll votes, sent as Discord's client sends them.
import { snowflakeArg } from '@shared/discord';
import { POLL_ANSWERS_MAX, type OwnerPollVote } from '@shared/polls';
import type { DiscordWriter } from './client';

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
