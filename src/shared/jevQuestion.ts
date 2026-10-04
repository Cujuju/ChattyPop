// Owner-written Jev questions (rules, tags, the right-click check): their shapes, Jev's limits, and validation.

/** Jev's limits on one question (TypeSafe API): choice options and score levels. */
export const CHOICE_OPTIONS_MAX = 255;
export const SCORE_LEVELS_MIN = 2;
export const SCORE_LEVELS_MAX = 10;
const CHOICE_OPTIONS_MIN = 2;

/** An owner-written Jev question about `message`: yes/no, pick one, or a score on levels (lowest first). */
export type JevQuestionSpec =
  | { type: 'noul'; question: string; yes: string; no: string }
  | { type: 'choice'; question: string; options: { name: string; description: string }[] }
  | { type: 'score'; question: string; levels: string[] };
type SpecOf<K extends JevQuestionSpec['type']> = Extract<JevQuestionSpec, { type: K }>;

/** The owner's own Jev question for a topic, and when its answer raises an alert. */
export type CustomJevQuestion =
  | (SpecOf<'noul'> & { minProbability: number })
  | (SpecOf<'choice'> & { alertOn: string[]; minProbability: number })
  | (SpecOf<'score'> & { minScore: number });

/** Throws with a message for the builder when Jev can't be asked the question. */
export function validateJevSpec(q: JevQuestionSpec): void {
  if (!q.question.trim()) throw new Error('Write the question Jev should answer.');
  switch (q.type) {
    case 'noul':
      return;
    case 'choice': {
      const names = q.options.map((o) => o.name.trim());
      if (names.length < CHOICE_OPTIONS_MIN || names.length > CHOICE_OPTIONS_MAX) throw new Error(`Give ${CHOICE_OPTIONS_MIN}–${CHOICE_OPTIONS_MAX} options.`);
      if (names.some((n) => !n) || new Set(names).size !== names.length) throw new Error('Each option needs a unique name.');
      return;
    }
    case 'score':
      if (q.levels.length < SCORE_LEVELS_MIN || q.levels.length > SCORE_LEVELS_MAX || q.levels.some((l) => !l.trim())) {
        throw new Error(`Describe ${SCORE_LEVELS_MIN}–${SCORE_LEVELS_MAX} levels, lowest first.`);
      }
  }
}

/** Error texts for a condition check, worded for the editor showing them. */
export interface ConditionErrors {
  threshold: string;
  options: string;
  level: string;
}

/** Throws when the condition can never be met: threshold outside (0, 1), no or unknown alert options (when `checkOptions`), or a level out of range. */
export function validateCondition(q: CustomJevQuestion, msg: ConditionErrors, checkOptions = true): void {
  switch (q.type) {
    case 'noul':
      if (!(q.minProbability > 0 && q.minProbability < 1)) throw new Error(msg.threshold);
      return;
    case 'choice': {
      const names = q.options.map((o) => o.name.trim());
      if (checkOptions && (!q.alertOn.length || q.alertOn.some((a) => !names.includes(a)))) throw new Error(msg.options);
      if (!(q.minProbability > 0 && q.minProbability < 1)) throw new Error(msg.threshold);
      return;
    }
    case 'score':
      if (!(q.minScore >= 0 && q.minScore <= q.levels.length - 1)) throw new Error(msg.level);
  }
}

const ALERT_CONDITION_ERRORS: ConditionErrors = {
  threshold: 'Pick an alert threshold between 0 and 100%.',
  options: 'Pick which options raise an alert.',
  level: 'Pick the level at which to alert.',
};

/** Throws with a message for the editor when the question can't be asked or can never alert. */
export function validateJevQuestion(q: CustomJevQuestion): void {
  validateJevSpec(q);
  validateCondition(q, ALERT_CONDITION_ERRORS);
}
