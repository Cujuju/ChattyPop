import { beforeEach, describe, expect, it } from 'vitest';
import { ruleSubject } from '@shared/rules';
import type { CustomJevQuestion } from '@shared/jevQuestion';
import { ARRIVAL } from '../src/core/arrival';
import { settleAsync } from './helpers';
import { probeAction, ruleHarness, ruleInput, runsOf, type Harness } from './ruleHarness';

let h: Harness;
beforeEach(() => {
  h = ruleHarness();
  h.jev.on.ruleQuestions = true;
});

const ASK: CustomJevQuestion = {
  type: 'noul',
  question: 'Is it about keyboards?',
  yes: '',
  no: '',
  minProbability: 0.5,
};
const jevRule = (o: Parameters<typeof ruleInput>[1] = {}) =>
  h.rules.create(ruleInput([probeAction()], { ...o, match: { jev: ASK } }));
const questionsAsked = (): string[] => h.jev.requests.flatMap((r) => Object.keys(r.questions));

describe('rule Jev question', () => {
  it('fires when the answer meets the condition, not otherwise', async () => {
    const id = jevRule();
    h.jev.values = { [ruleSubject(id)]: 0.9 };
    const yes = h.say('new keycaps!');
    await settleAsync();
    h.jev.values = { [ruleSubject(id)]: 0.1 };
    h.say('lunch?');
    await settleAsync();
    expect(runsOf(h, id).map((r) => r[0])).toEqual([yes.id]);
  });

  it('asks only once the gates and narrowing pass', async () => {
    const id = jevRule({ narrow: { contains: ['link'] } });
    h.say('lunch?');
    await settleAsync();
    expect(questionsAsked()).toEqual([]);
    h.say('new board https://example.com/kb');
    await settleAsync();
    expect(questionsAsked()).toEqual([ruleSubject(id)]);
  });

  it("rides the same one request per message as other rules' questions", async () => {
    h.jev.on.topicMeaning = true;
    const byMeaning = h.rules.create(ruleInput([probeAction()], { match: { meaning: 'keyboards' } }));
    const id = jevRule();
    h.jev.requests = [];
    h.say('new keycaps!');
    await settleAsync();
    expect(h.jev.requests).toHaveLength(1);
    expect(questionsAsked().sort()).toEqual([ruleSubject(id), ruleSubject(byMeaning)].sort());
  });

  it('never asks while its switch is off, nor about a local-AI-only channel', async () => {
    const id = jevRule();
    h.jev.values = { [ruleSubject(id)]: 0.9 };
    h.jev.on.ruleQuestions = false;
    h.say('off');
    h.jev.on.ruleQuestions = true;
    h.db.prepare('UPDATE channels SET local_ai_only = 1 WHERE id = ?').run('c1');
    h.say('local only');
    await settleAsync();
    expect([questionsAsked(), runsOf(h, id)]).toEqual([[], []]);
  });

  it('does not ask about a missed message unless the rule takes missed ones', async () => {
    jevRule();
    h.say('fetched', { via: ARRIVAL.sync });
    await settleAsync();
    expect(questionsAsked()).toEqual([]);
  });

  it('works only with the new-message trigger', () => {
    const input = ruleInput([probeAction()], { match: { jev: ASK } });
    // A plugin trigger that also starts on messages.
    const onProbeStart = { ...input, spec: { ...input.spec, trigger: { type: 'ruleprobe.start', config: 'yes' } } };
    expect(() => h.rules.create(onProbeStart)).toThrow(/new messages/);
  });
});
