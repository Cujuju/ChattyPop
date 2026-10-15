// Jev answers reach callers whole or not at all: a malformed choice or score is "no judgment", never a throw downstream.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { answerValue, type Answer, type Question } from '../src/core/ai/decisions';
import { JevProvider, openRouterJevRoute } from '../src/core/ai/jev';
import { specMatch } from '../src/core/jev/queries';

const OPTIONS = { yes: 'It is.', no: 'It is not.' };
const LEVELS = ['low', 'mid', 'high'];
const questions: Record<string, Question> = {
  c: { type: 'choice', instructions: 'pick', criteria: OPTIONS },
  s: { type: 'score', instructions: 'rate', criteria: LEVELS },
};

/** Asks `questions` through the real provider over a fake HTTP 200 carrying `answers`. */
async function received(answers: Record<string, unknown>): Promise<Record<string, unknown>> {
  vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ answers }) }));
  const jev = new JevProvider(() => undefined).via(openRouterJevRoute({ id: 'k', label: 'K', key: 'sk', hint: '…', models: [], anyModel: true }));
  return (await jev.decide({ state: 'x', questions })).answers;
}

const choiceMatch = specMatch({ type: 'choice', question: 'q', options: [], alertOn: ['yes'], minProbability: 0 } as never);
const scoreMatch = specMatch({ type: 'score', question: 'q', levels: LEVELS, minScore: 1 } as never);

describe('Jev answer validation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps well-formed choice and score answers, which consumers read', async () => {
    const a = await received({
      c: { type: 'choice', choice: 'yes', probabilities: { yes: 0.9, no: 0.1 }, confidence: 0.9 },
      s: { type: 'score', score: 1.5, legend: {}, probabilities: { 0: 0.1, 1: 0.3, 2: 0.6 }, confidence: 0.6 },
    });
    expect(answerValue(a['c'] as Answer)).toEqual({ value: 0.9, choice: 'yes' });
    expect(scoreMatch(a['s'] as Answer)).toBeCloseTo(0.9);
  });

  it('drops choice and score answers without a readable probability map', async () => {
    for (const probabilities of [undefined, null, [0.5], 'x', { yes: 2 }, { yes: Number.NaN }]) {
      const a = await received({
        c: { type: 'choice', choice: 'yes', confidence: 0.9, ...(probabilities === undefined ? {} : { probabilities }) },
        s: { type: 'score', score: 1, confidence: 0.9, ...(probabilities === undefined ? {} : { probabilities }) },
      });
      expect(a).toEqual({});
    }
  });

  it('drops options and levels the question does not have', async () => {
    const a = await received({
      c: { type: 'choice', choice: 'toString', probabilities: {}, confidence: 0.9 },
      s: { type: 'score', score: 1, probabilities: { 7: 0.5 }, confidence: 0.9 },
    });
    expect(a).toEqual({});
    const b = await received({
      c: { type: 'choice', choice: 'yes', probabilities: { maybe: 0.5 }, confidence: 0.9 },
      s: { type: 'score', score: LEVELS.length, probabilities: {}, confidence: 0.9 },
    });
    expect(b).toEqual({});
  });

  it('consumers never throw on what passes', async () => {
    const a = await received({
      c: { type: 'choice', choice: 'yes', probabilities: {}, confidence: 0.7 },
      s: { type: 'score', score: 2, probabilities: {}, confidence: 0.7 },
    });
    expect(answerValue(a['c'] as Answer).value).toBe(0.7); // the chosen option's probability absent: its confidence
    expect(choiceMatch(a['c'] as Answer)).toBe(0.7);
    expect(scoreMatch(a['s'] as Answer)).toBe(0);
  });
});
