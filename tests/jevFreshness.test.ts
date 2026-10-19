// A Jev answer belongs to the question it answered: one that changed or went away meanwhile is neither stored nor acted on.
import { describe, expect, it } from 'vitest';
import type { RawMessage } from '@shared/discord';
import type { DecisionRequest, DecisionResult, Question } from '../src/core/ai/decisions';
import { ARRIVAL, type Arrival } from '../src/core/arrival';
import type { Db } from '../src/core/db';
import { storeDerivedText } from '../src/core/derivedText';
import { registerMessageQuestion } from '../src/core/jev/messageQuestions';
import { addedTextArrival, textMessage } from '../src/core/queries/messageText';
import type { FakeJev } from './fakeJev';
import { settleAsync } from './helpers';
import { probeRule, ruleHarness, runsOf, type Harness } from './ruleHarness';

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
  await h.matcher.catchUpJudgments();
  hold.release();
  await settleAsync();
  expect(runsOf(h, id)).toEqual([]);
  expect(judgments(h.db, m.id)).toEqual([{ subject: `rule:${id}`, value: 0.01 }]);
});

/** Holds each Jev request until its answer is released by index (in asked order), so answers can arrive out of order. */
function holdEach(jev: FakeJev) {
  const decide = jev.decide.bind(jev);
  const held: (() => void)[] = [];
  jev.decide = (<Q extends Record<string, Question>>(req: DecisionRequest<Q>): Promise<DecisionResult<Q>> =>
    new Promise((resolve, reject) => held.push(() => void decide(req).then(resolve, reject)))) as FakeJev['decide'];
  return { held, release: async (i: number) => { held[i]!(); await settleAsync(); } };
}

/** Text that takes an announcement back. */
const RETRACTION = 'never mind';
/** Answers yes when the message asked about announces a group buy it doesn't take back, and no otherwise. */
const yesUnlessRetracted = (req: DecisionRequest<Record<string, Question>>) => {
  const said = JSON.stringify(req.state);
  return Object.fromEntries(Object.keys(req.questions).map((k) => [k, { type: 'noul', noul: said.includes('GB opens') && !said.includes(RETRACTION) ? 0.99 : 0.01 }]));
};

describe('an answer about text the message no longer has', () => {
  for (const [change, newer] of [
    ['an edit', (h: Harness, m: RawMessage) => h.archive.ingestMessages([{ ...m, content: `${RETRACTION}, withdrawn` }], ARRIVAL.gateway)],
    [
      'later derived text',
      (h: Harness, m: RawMessage) => {
        storeDerivedText(h.db, m.id, 'p:transcript', 1, `${RETRACTION}, cancelled`);
        h.matcher.check(textMessage(h.db, m.id)!, addedTextArrival(h.db, m.id, Date.now()));
      },
    ],
  ] as const) {
    it(`arriving after the answer for ${change} is neither stored nor acted on`, async () => {
      const h = ruleHarness();
      h.jev.on.topicMeaning = true;
      h.jev.answer = yesUnlessRetracted;
      const id = h.rules.create(probeRule({ meaning: 'group buys' }, { gates: { edits: true } }));
      const hold = holdEach(h.jev);
      const m = h.say('GB opens friday');
      newer(h, m);
      expect(hold.held).toHaveLength(2);
      await hold.release(1); // the newer text's answer first
      await hold.release(0);
      expect(runsOf(h, id)).toEqual([]);
      expect(judgments(h.db, m.id)).toEqual([{ subject: `rule:${id}`, value: 0.01 }]);
    });
  }
});

describe('a rule whose gates changed while Jev was asked', () => {
  const AUTHOR = '900000000000000001';
  const cases: [string, Arrival, Parameters<typeof probeRule>[1]][] = [
    ['its authors', ARRIVAL.gateway, { gates: { authorIds: ['900000000000000002'] } }],
    ['excluding the author', ARRIVAL.gateway, { gates: { authorIds: [AUTHOR], authorsNot: true } }],
    ['its server', ARRIVAL.gateway, { gates: { guildIds: ['g2'] } }],
    ['taking no missed messages', ARRIVAL.sync, { gates: { missed: false } }],
    ['its link narrowing', ARRIVAL.gateway, { narrow: { linkPlatforms: ['youtube'] } }],
  ];
  for (const [change, via, edited] of cases) {
    it(`acts on no message ${change} now excludes`, async () => {
      const h = ruleHarness();
      h.jev.on.topicMeaning = true;
      h.jev.answer = yesAbout('group buys');
      const id = h.rules.create(probeRule({ meaning: 'group buys' }));
      const hold = holdJev(h.jev);
      h.say('GB closes friday', { author: AUTHOR, via });
      h.rules.update(id, probeRule({ meaning: 'group buys' }, edited));
      hold.release();
      await settleAsync();
      expect(runsOf(h, id)).toEqual([]);
    });
  }

  it('acts when the edit excludes nothing', async () => {
    const h = ruleHarness();
    h.jev.on.topicMeaning = true;
    h.jev.answer = yesAbout('group buys');
    const id = h.rules.create(probeRule({ meaning: 'group buys' }));
    const hold = holdJev(h.jev);
    const m = h.say('GB closes friday', { author: AUTHOR });
    h.rules.update(id, probeRule({ meaning: 'group buys' }, { gates: { authorIds: [AUTHOR] } }));
    hold.release();
    await settleAsync();
    expect(runsOf(h, id)).toEqual([[m.id, true, ['done']]]);
  });
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
  await h.matcher.catchUpJudgments();
  await settleAsync();
  expect(judgments(h.db, m.id)).toEqual([{ subject: 'r2:stocks', value: 0.99 }]);
  offAgain();
});
