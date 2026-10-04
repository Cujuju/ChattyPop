import { DEFAULT_AI_SETTINGS, jevFeatureOn, type JevFeature, type JevSettings } from '@shared/settings';
import { stampedName } from '@shared/bundledTypes';
import type { DecisionProvider, DecisionRequest, DecisionResult, Question } from '../src/core/ai/decisions';

/** Any Jev request, as the fake records it. */
export type JevRequest = DecisionRequest<Record<string, Question>>;
/** Answers a request by question id; throwing fails the request. */
export type JevAnswer = (req: JevRequest) => Record<string, unknown>;

/** The fake Jev's request budget: larger than any test request. */
const FAKE_JEV_MAX_INPUT_CHARS = 64_000;

/**
 * A Jev stand-in: answers with `answer` when given, else from `values` by question id or batched subject (a number becomes a noul or a
 * score by question type; an object is returned as the answer). Records every request, and can be made to fail.
 */
export class FakeJev implements DecisionProvider {
  readonly model = 'fake-jev';
  readonly maxInputChars = FAKE_JEV_MAX_INPUT_CHARS;
  requests: JevRequest[] = [];
  values: Record<string, number | object> = {};
  fail = false;
  /** Feature switches `forFeature` reads; all off, as in the defaults. */
  on: JevSettings = { ...DEFAULT_AI_SETTINGS.jev };

  constructor(
    public answer?: JevAnswer,
    /** Reported for every answered request. */
    public costUsd: number | null = null,
  ) {}

  /** This Jev while feature `f` is on, else null: the app's per-feature Jev accessor. */
  forFeature = (f: JevFeature): DecisionProvider | null => (jevFeatureOn(this.on, f) ? this : null);
  /** `forFeature` as plugin `pluginId`'s own code asks: by its local switch key, which the host stamps. */
  forPlugin = (pluginId: string) => (f: string): DecisionProvider | null => this.forFeature(stampedName(pluginId, f));

  async decide<Q extends Record<string, Question>>(req: DecisionRequest<Q>): Promise<DecisionResult<Q>> {
    this.requests.push(req as JevRequest);
    if (this.fail) throw new Error('Jev down');
    const answers = this.answer ? this.answer(req as JevRequest) : this.fromValues(req as JevRequest);
    return { answers: answers as DecisionResult<Q>['answers'], costUsd: this.costUsd };
  }

  private fromValues(req: JevRequest): Record<string, unknown> {
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      // A batched question's id is its subject then its message id (batchKey).
      const v = this.values[id] ?? Object.entries(this.values).find(([subject]) => id.startsWith(`${subject}_`))?.[1];
      if (v === undefined) continue;
      if (typeof v === 'object') answers[id] = v;
      else answers[id] = q.type === 'score' ? { type: 'score', score: v, legend: {}, probabilities: {}, confidence: 1 } : { type: 'noul', noul: v };
    }
    return answers;
  }
}

/** A choice answer with the chosen option at probability `p`. */
export const choice = (option: string, p: number) => ({ type: 'choice', choice: option, probabilities: { [option]: p }, confidence: p });
/** A score answer with per-level probabilities. */
export const score = (value: number, probabilities: Record<string, number>) => ({ type: 'score', score: value, legend: {}, probabilities, confidence: 1 });
