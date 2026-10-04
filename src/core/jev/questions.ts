// Owner-written Jev questions as requests, and the Jev question behind each rule's match with when its answer matches.
import type { JevFeature } from '@shared/settings';
import type { JevQuestionSpec } from '@shared/jevQuestion';
import type { Answer, Question } from '../ai/decisions';

/** Settings → Jev → Queries id of the host's generic meaning match. */
export const QUERY = { meaning: 'rules.meaning' } as const;

/** The owner as Jev sees them: display names plus the raw mention token Discord puts in message text. */
export interface Me {
  names: string[];
  mention: string;
}

export interface RuleQuestion {
  subject: string;
  /** The Settings → Jev switches that allow asking it; any one is enough. */
  features: readonly JevFeature[];
  question: Question;
  /** The alert's probability when the answer matches, else null. */
  match: (a: Answer) => number | null;
}

const CONTEXT_NOTE = 'Read `earlier` and `replying_to` only to understand what `message` refers to.';

/** The request form of an owner-written question (rule, tag, right-click check or channel ask). */
export function customQuestion(q: JevQuestionSpec): Question {
  const instructions = `${q.question.trim()} ${CONTEXT_NOTE}`;
  switch (q.type) {
    case 'noul':
      return { type: 'noul', instructions, criteria: { true: q.yes.trim() || 'Yes.', false: q.no.trim() || 'No.' } };
    case 'choice':
      return {
        type: 'choice',
        instructions,
        criteria: Object.fromEntries(q.options.map((o) => [o.name.trim(), o.description.trim() || null])),
      };
    case 'score':
      return { type: 'score', instructions, criteria: q.levels.map((l) => l.trim()) };
  }
}
