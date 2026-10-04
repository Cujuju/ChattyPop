// Several messages in one Jev request (re-runs, catch-up), as System One batches records: its questions run independently,
// so each carries its own message's state in its instructions object ("put the question in one field and the data in the
// others") and the request's state is empty. A shared state would set every message before every question, which lowers
// Jev's confidence (docs.typesafe.ai: "include only the context relevant to the current questions").
import type { Question } from '../ai/decisions';

/** The state fields (MessageJudge.stateFor) questions refer to by backticked path. */
const FIELD_REF = /`(message|earlier|replying_to)`/;

/** A batched request's state: its questions carry their messages' states. */
export const BATCH_STATE = {};

/** A batched question's id: its subject, then its message's id, so ids stay unique across messages. */
export const batchKey = (subject: string, messageId: string): string => `${subject}_${messageId}`;

/**
 * `q` carrying `state` beside its question text, so the fields it names resolve there. Null when it can't, and it is
 * asked with its message alone: it names no state field (an owner's plain-text question, which can't say which data it
 * means), its instructions are an array or have no question text, or they already use a state field's name.
 */
export function carriedQuestion(q: Question, state: Record<string, unknown>): Question | null {
  const asks = typeof q.instructions === 'string' ? q.instructions : Array.isArray(q.instructions) ? null : q.instructions['question'];
  if (typeof asks !== 'string') return null;
  if (!FIELD_REF.test(asks) && !FIELD_REF.test(JSON.stringify(q.criteria ?? null))) return null;
  if (typeof q.instructions !== 'string' && Object.keys(state).some((k) => Object.hasOwn(q.instructions as object, k))) return null;
  const data = typeof q.instructions === 'string' ? { question: q.instructions } : q.instructions;
  return { ...q, instructions: { ...state, ...data } };
}
