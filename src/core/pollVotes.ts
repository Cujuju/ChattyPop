// Poll votes on stored messages: the gateway's MESSAGE_POLL_VOTE_* events and the owner's own vote, kept in raw_json.
import { applyPollVote, type OwnerPollVote, type RawPoll } from '@shared/polls';
import { parseRawJson, type Db } from './db';

/** A MESSAGE_POLL_VOTE_ADD / _REMOVE payload (the fields read here). */
export interface PollVoteEvent {
  channel_id: string;
  message_id: string;
  answer_id: number;
  user_id?: string;
}

/** Runs `change` on the stored message's poll and saves it when it changed; false when there's no poll or nothing changed. */
function changePoll(db: Db, messageId: string, change: (poll: RawPoll) => boolean): boolean {
  const row = db.prepare('SELECT raw_json FROM messages WHERE id = ?').get(messageId) as { raw_json: string | Buffer | null } | undefined;
  const msg = parseRawJson<{ poll?: RawPoll }>(row?.raw_json ?? null);
  if (!msg?.poll || !change(msg.poll)) return false;
  db.prepare('UPDATE messages SET raw_json = ? WHERE id = ?').run(JSON.stringify(msg), messageId);
  return true;
}

/** One vote added or taken back; the owner's echo of their own applied vote changes nothing. */
export const applyPollVoteEvent = (db: Db, t: 'MESSAGE_POLL_VOTE_ADD' | 'MESSAGE_POLL_VOTE_REMOVE', d: PollVoteEvent, selfId: string | null): boolean =>
  changePoll(db, d.message_id, (poll) => applyPollVote(poll, d.answer_id, t === 'MESSAGE_POLL_VOTE_ADD', selfId !== null && d.user_id === selfId));

/** The owner's vote, as the answers they now choose: votes on others are taken back, new ones added. */
export const applyOwnPollVoteTo = (db: Db, v: OwnerPollVote): boolean =>
  changePoll(db, v.messageId, (poll) => {
    const chosen = new Set(v.answerIds);
    let changed = false;
    for (const a of poll.answers ?? []) {
      if (typeof a.answer_id !== 'number') continue;
      changed = applyPollVote(poll, a.answer_id, chosen.has(a.answer_id), true) || changed;
    }
    return changed;
  });
