// Decision models (Jev): typed judgments about text, never generated text. Shapes follow TypeSafe's System One API.

/** Instructions, criteria and state accept plain text or JSON structure. */
export type Structured = string | Record<string, unknown> | unknown[];

/** Yes/no; the answer is the probability of yes. */
export interface NoulQuestion {
  type: 'noul';
  instructions: Structured;
  criteria?: { true?: Structured; false?: Structured };
}

/** One option from a set (at most 255). */
export interface ChoiceQuestion {
  type: 'choice';
  instructions: Structured;
  criteria: Record<string, Structured | null>;
}

/** A position on 2–10 ordered levels. */
export interface ScoreQuestion {
  type: 'score';
  instructions: Structured;
  criteria: Structured[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: 'noul';
  noul: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: 'score';
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** An answer as one number (yes probability, the chosen option's probability, or the score) plus the chosen option. */
export function answerValue(a: Answer): { value: number; choice: string | null } {
  switch (a.type) {
    case 'noul':
      return { value: a.noul, choice: null };
    case 'choice':
      return { value: a.probabilities[a.choice] ?? a.confidence, choice: a.choice };
    case 'score':
      return { value: a.score, choice: null };
  }
}

export type AnswerFor<Q extends Question> = Q extends NoulQuestion ? NoulAnswer : Q extends ChoiceQuestion ? ChoiceAnswer : ScoreAnswer;

export interface DecisionRequest<Q extends Record<string, Question>> {
  state: Structured;
  questions: Q;
  signal?: AbortSignal;
  /** Run just before each send, retries included: a throw refuses the request unsent. The read scope sets it. */
  admit?: () => void;
}

export interface DecisionResult<Q extends Record<string, Question>> {
  /** Callers treat a missing answer as "no judgment" and fall back to their safe default. */
  answers: { [K in keyof Q]?: AnswerFor<Q[K]> };
  /** USD for the request, when the service reports it. */
  costUsd: number | null;
}

export interface DecisionProvider {
  /** Model version the answers came from; thresholds are tuned per version. */
  readonly model: string;
  /** Largest state + questions, in characters, one request may carry. */
  readonly maxInputChars: number;
  decide<Q extends Record<string, Question>>(req: DecisionRequest<Q>): Promise<DecisionResult<Q>>;
}

/** Total USD of requests' reported costs; null when none reported one (unknown, not free). */
export const sumCosts = (costs: number[]): number | null => (costs.length ? costs.reduce((a, b) => a + b, 0) : null);

/** Batches questions with record-specific data. Returns null for ambiguous field references, unsupported instructions or conflicting field names; those records run individually. */
export function carriedQuestion(q: Question, data: Record<string, unknown>): Question | null {
  const asks = typeof q.instructions === 'string' ? q.instructions : Array.isArray(q.instructions) ? null : q.instructions['question'];
  if (typeof asks !== 'string') return null;
  const named = `${asks}\n${JSON.stringify(q.criteria ?? null)}`;
  if (!Object.keys(data).some((k) => named.includes(`\`${k}\``))) return null;
  if (typeof q.instructions !== 'string' && Object.keys(data).some((k) => Object.hasOwn(q.instructions as object, k))) return null;
  return { ...q, instructions: { ...data, ...(typeof q.instructions === 'string' ? { question: q.instructions } : q.instructions) } };
}
