// Several messages in one Jev request (re-runs, catch-up). Jev judges only the state, and its questions name state fields
// by backticked path. So a batched state holds each message's own state under a key (m1, m2…), and each question's
// references to `message`, `earlier` and `replying_to` are pointed at its message's key (`m2.message`).
import type { Question, Structured } from '../ai/decisions';

/** The state fields (MessageJudge.stateFor) questions refer to by backticked path. */
const FIELD_REF = /`(message|earlier|replying_to)`/g;

/** The key of the `n`th message (1-based) in a batched state. */
export const batchStateKey = (n: number): string => `m${n}`;

/** A batched question's id: its subject, then its message's id, so ids stay unique across messages. */
export const batchKey = (subject: string, messageId: string): string => `${subject}_${messageId}`;

/**
 * `q` pointed at the message under `key`: every backticked field reference in its question text and criteria gains the
 * key. Null when the question names none (an owner's plain-text question): it can't tell which message it means, so it
 * must be asked with its message alone. Values carried beside the question text (`me`, `topic`) are left as they are.
 */
export function scopedQuestion(q: Question, key: string): Question | null {
  let refs = 0;
  const text = (s: string): string =>
    s.replace(FIELD_REF, (_, field: string) => {
      refs++;
      return `\`${key}.${field}\``;
    });
  const any = (v: Structured | null): Structured | null => (typeof v === 'string' ? text(v) : v);
  const instructions =
    typeof q.instructions === 'string'
      ? text(q.instructions)
      : Array.isArray(q.instructions) || typeof q.instructions['question'] !== 'string'
        ? q.instructions
        : { ...q.instructions, question: text(q.instructions['question']) };
  let scoped: Question;
  switch (q.type) {
    case 'noul':
      scoped = { ...q, instructions, ...(q.criteria ? { criteria: { true: any(q.criteria.true ?? null) ?? undefined, false: any(q.criteria.false ?? null) ?? undefined } } : {}) };
      break;
    case 'choice':
      scoped = { ...q, instructions, criteria: Object.fromEntries(Object.entries(q.criteria).map(([k, v]) => [k, any(v)])) };
      break;
    case 'score':
      scoped = { ...q, instructions, criteria: q.criteria.map((c) => any(c) ?? c) };
      break;
  }
  return refs ? scoped : null;
}
