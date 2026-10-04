// A Jev answer belongs to the question it answered: one that changed or went away meanwhile is neither stored nor acted on.
import { expect, it } from 'vitest';
import type { DecisionRequest, DecisionResult, Question } from '../src/core/ai/decisions';
import type { Db } from '../src/core/db';
import { registerMessageQuestion } from '../src/core/jev/messageQuestions';
import type { FakeJev } from './fakeJev';
import { settleAsync } from './helpers';
import { probeRule, ruleHarness, runsOf } from './ruleHarness';

/** Holds Jev's requests while `holding`; `release` answers the held ones in the order they were asked. */
function holdJev(jev: FakeJev) {
  const decide = jev.decide.bind(jev);
  const held: (() => void)[] = [];
  const state = { holding: true, release: () => held.splice(0).forEach((answer) => answer()) };
  jev.decide = (<Q extends Record<string, Question>>(req: DecisionRequest<Q>): Promise<DecisionResult<Q>> =>
    state.holding
      ? new Promise((resolve, reject) => held.push(() => void decide(req).then(resolve, reject)))
      : decide(req)) as FakeJev['decide'];
  return state;
}

/** Answers yes to every question whose text mentions `word`, and no to the rest. */
const yesAbout = (word: string) => (req: DecisionRequest<Record<string, Question>>) =>
  Object.fromEntries(Object.entries(req.questions).map(([k, q]) => [k, { type: 'noul', noul: JSON.stringify(q).includes(word) ? 0.99 : 0.01 }]));

const judgments = (db: Db, messageId: string) =>
  db.prepare('SELECT subject, value FROM jev_judgments WHERE message_id = ? ORDER BY subject').all(messageId);

/** A plugin's switch for its per-message question. */
const FEATURE = 'r2.stocks';
/** A per-message question a plugin registers while on; returns its removal (the plugin turning off). */
const stocksQuestion = () =>
  registerMessageQuestion({ subject: 'r2:stocks', feature: FEATURE, question: () => ({ type: 'noul', instructions: 'Does it mention a stock?' }) });

it('drops an answer to a rule question edited while Jev was asked, so it neither acts nor is stored', async () => {
  const h = ruleHarness();
  h.jev.on.topicMeaning = true;
  h.jev.answer = yesAbout('group buys');
  const input = probeRule({ meaning: 'group buys' });
  const id = h.rules.create(input);
  const hold = holdJev(h.jev);
  const m = h.say('GB closes friday');
  h.rules.update(id, probeRule({ meaning: 'keyboard reviews' }));
  hold.release();
  await settleAsync();
  expect(runsOf(h, id)).toEqual([]);
  expect(judgments(h.db, m.id)).toEqual([{ subject: `rule:${id}`, value: 0.01 }]);
});

it('does not store a per-message answer that arrives after its plugin turned off, so turning it on asks again', async () => {
  const h = ruleHarness();
  h.jev.on[FEATURE] = true;
  h.jev.answer = yesAbout('stock');
  const off = stocksQuestion();
  const hold = holdJev(h.jev);
  const m = h.say('NVDA to the moon');
  off();
  hold.release();
  await settleAsync();
  expect(judgments(h.db, m.id)).toEqual([]);
  hold.holding = false;
  const offAgain = stocksQuestion();
  h.matcher.catchUpJudgments();
  await settleAsync();
  expect(judgments(h.db, m.id)).toEqual([{ subject: 'r2:stocks', value: 0.99 }]);
  offAgain();
});
