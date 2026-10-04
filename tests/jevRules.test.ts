// Rules with the owner's own Jev question, and per-message questions registered alongside them.
import { beforeEach, describe, expect, it } from 'vitest';
import type { CustomJevQuestion } from '@shared/jevQuestion';
import type { Archive } from '../src/core/archive';
import type { Db } from '../src/core/db';
import { registerMessageQuestion } from '../src/core/jev/messageQuestions';
import type { FakeJev } from './fakeJev';
import { choice, score } from './fakeJev';
import { OWNER, from, nextTs, rawMessage, settleAsync } from './helpers';
import { ARRIVAL } from '../src/core/arrival';
import { probeRule, ruleHarness, type Harness } from './ruleHarness';

let h: Harness;
let db: Db;
let jev: FakeJev;
let rules: Harness['rules'];
let archive: Archive;
beforeEach(() => {
  h = ruleHarness();
  ({ db, jev, rules, archive } = h);
  h.matcher.setSelf(OWNER);
});

/** Each message is just after now, so newer than the rules the test made (older ones land as read history). */
const msg = (content: string, author = 'u2', extra = {}) => rawMessage('c1', nextTs(), content, { ...from(author), ...extra });
const custom = (q: CustomJevQuestion) => rules.create(probeRule({ jev: q }, { name: 'custom' }));
/** The probe's match probability for each run, newest first. */
const matched = () => h.probe.runs.map((r) => (r.event.kind === 'message' ? r.event.hit.probability : null)).reverse();

describe('custom Jev question rules', () => {
  beforeEach(() => {
    jev.on.ruleQuestions = true;
  });

  it('yes/no matches at or above its threshold', async () => {
    const id = custom({ type: 'noul', question: 'Does `message` ask for a ride?', yes: 'Asks for a ride', no: 'Anything else', minProbability: 0.6 });
    jev.values = { [`rule:${id}`]: 0.65 };
    archive.ingestMessages([msg('can someone drive me to the airport?')], ARRIVAL.gateway);
    await settleAsync();
    expect(matched()[0]).toBe(0.65);
    const q = jev.requests.at(-1)!.questions[`rule:${id}`]!;
    expect(q).toMatchObject({ type: 'noul', criteria: { true: 'Asks for a ride', false: 'Anything else' } });
  });

  it('pick-one matches only on the chosen options and stores the label', async () => {
    const options = [
      { name: 'sell', description: 'Selling something' },
      { name: 'buy', description: 'Looking to buy' },
      { name: 'other', description: '' },
    ];
    const id = custom({ type: 'choice', question: 'What is `message` about?', options, alertOn: ['sell'], minProbability: 0.7 });
    jev.values = { [`rule:${id}`]: choice('buy', 0.8) };
    const a = msg('WTB a keyboard');
    archive.ingestMessages([a], ARRIVAL.gateway);
    await settleAsync();
    expect(matched()).toEqual([]);
    expect(db.prepare('SELECT label, value FROM jev_judgments WHERE message_id = ?').get(a.id)).toEqual({ label: 'buy', value: 0.8 });
    jev.values = { [`rule:${id}`]: choice('sell', 0.6) };
    archive.ingestMessages([msg('maybe selling?')], ARRIVAL.gateway);
    await settleAsync();
    expect(matched()).toEqual([]); // ticked option, but below the threshold
    jev.values = { [`rule:${id}`]: choice('sell', 0.9) };
    archive.ingestMessages([msg('WTS my old board')], ARRIVAL.gateway);
    await settleAsync();
    expect(matched()[0]).toBe(0.9);
  });

  it('score matches at or above its level, showing the chance of that level or higher', async () => {
    const id = custom({ type: 'score', question: 'How heated is `message`?', levels: ['calm', 'tense', 'heated'], minScore: 1.5 });
    jev.values = { [`rule:${id}`]: score(1.2, { '0': 0.2, '1': 0.4, '2': 0.4 }) };
    archive.ingestMessages([msg('eh')], ARRIVAL.gateway);
    await settleAsync();
    expect(matched()).toEqual([]);
    jev.values = { [`rule:${id}`]: score(1.8, { '0': 0, '1': 0.2, '2': 0.8 }) };
    archive.ingestMessages([msg('you are all wrong!!')], ARRIVAL.gateway);
    await settleAsync();
    expect(matched()[0]).toBe(0.8);
  });

  it('rejects a question that can never match', () => {
    expect(() => custom({ type: 'choice', question: 'x', options: [{ name: 'a', description: '' }, { name: 'b', description: '' }], alertOn: [], minProbability: 0.7 })).toThrow(/options meet/);
    expect(() => custom({ type: 'score', question: 'x', levels: ['only'], minScore: 0 })).toThrow(/levels/);
  });
});

describe('registered per-message questions', () => {
  it('ride in the same request, only while a listed toggle is on, and get their answer', async () => {
    const seen: string[] = [];
    registerMessageQuestion({
      subject: 'test:probe',
      feature: ['catchUpBadges', 'keepImportant'],
      question: () => ({ type: 'noul', instructions: 'Probe?' }),
      onAnswer: (m, a) => seen.push(`${m.id}:${a.type === 'noul' ? a.noul : ''}`),
    });
    archive.ingestMessages([msg('nobody asks')], ARRIVAL.gateway);
    await settleAsync();
    expect(jev.requests).toEqual([]);
    jev.on.keepImportant = true;
    jev.on.ruleQuestions = true;
    const id = custom({ type: 'noul', question: 'q', yes: '', no: '', minProbability: 0.5 });
    jev.values = { 'test:probe': 0.4 };
    jev.requests = [];
    const m = msg('asked now');
    archive.ingestMessages([m], ARRIVAL.gateway);
    await settleAsync();
    expect(jev.requests.filter((r) => JSON.stringify(r.state).includes('asked now'))).toHaveLength(1);
    expect(Object.keys(jev.requests.at(-1)!.questions).sort()).toEqual([`rule:${id}`, 'test:probe']);
    expect(seen).toContain(`${m.id}:0.4`);
    registerMessageQuestion({ subject: 'test:probe', feature: 'pluginDecide', question: () => null });
  });
});
