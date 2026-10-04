import { beforeEach, describe, expect, it } from 'vitest';
import { storeDerivedText } from '../src/core/derivedText';
import { Archive } from '../src/core/archive';
import type { Db } from '../src/core/db';
import { askRange } from '../src/core/jev/askRange';
import { checkMessage } from '../src/core/jev/messageCheck';
import { MessageJudge } from '../src/core/jev/messageJudge';
import type { JevQuestionSpec } from '../src/shared/jevQuestion';
import { FakeJev, choice, score } from './fakeJev';
import { insertRule } from '../src/core/rules/ruleStore';
import { rawMessage, seedArchive, tempDb } from './helpers';
import { probeRule } from './ruleHarness';
import { ARRIVAL } from '../src/core/arrival';

let db: Db;
let jev: FakeJev;
let msgId: string;
beforeEach(() => {
  db = tempDb();
  jev = new FakeJev();
  const archive = seedArchive(db, [{ id: 'c1' }]);
  const m = rawMessage('c1', Date.now(), 'buy the dip, trust me bro');
  archive.ingestMessages([m], ARRIVAL.gateway);
  msgId = m.id;
});

const check = (ask: JevQuestionSpec | null = null) => checkMessage(db, new MessageJudge(db), jev, msgId, ask);

describe('Jev check of one message', () => {
  it('reads a voice message by its transcript', async () => {
    const voice = rawMessage('c1', Date.now() + 1, '');
    new Archive(db).ingestMessages([voice], ARRIVAL.gateway);
    storeDerivedText(db, voice.id, 'transcription:a1', 1, 'sell everything now'); // its transcript, as the plugin settles it
    await checkMessage(db, new MessageJudge(db), jev, voice.id, null);
    expect((jev.requests[0]!.state as { message: string }).message).toContain('sell everything now');
  });

  it('asks the standard checks, class labels and rules with a Jev question in one request', async () => {
    insertRule(db, probeRule({ jev: { type: 'noul', question: 'Is `message` shilling?', yes: '', no: '', minProbability: 0.7 } }, { name: 'Shilling' }), 0);
    jev.values = { trolling: 0.2, 'class:trading': 0.9, 'rule:1': 0.8 };
    const r = await check();
    expect(jev.requests).toHaveLength(1);
    expect(Object.keys(jev.requests[0]!.questions)).toEqual(expect.arrayContaining(['trolling', 'manipulation', 'coordination', 'humor', 'context', 'class:political', 'class:finance', 'class:trading', 'rule:1']));
    expect(r.checks).toEqual(
      expect.arrayContaining([
        { id: 'trolling', label: 'Trolling / baiting', kind: 'noul', value: 0.2, choice: null },
        { id: 'class:trading', label: 'Trading', kind: 'noul', value: 0.9, choice: null },
        { id: 'rule:1', label: 'Shilling', kind: 'noul', value: 0.8, choice: null },
      ]),
    );
    expect((jev.requests[0]!.state as { message: string }).message).toContain('buy the dip');
  });

  it('an ad-hoc question carries its meanings: yes/no, pick-one or score', async () => {
    jev.values = { ask: 0.6 };
    await check({ type: 'noul', question: 'Is `message` financial advice?', yes: 'It tells someone what to buy.', no: '' });
    expect(jev.requests[0]!.questions['ask']).toMatchObject({ type: 'noul', criteria: { true: 'It tells someone what to buy.', false: 'No.' } });
    jev.values = { ask: choice('joke', 0.7) };
    const r = await check({ type: 'choice', question: 'What is `message`?', options: [{ name: 'advice', description: 'A tip to act on.' }, { name: ' joke ', description: '' }] });
    expect(jev.requests[1]!.questions['ask']).toMatchObject({ type: 'choice', criteria: { advice: 'A tip to act on.', joke: null } });
    expect(r.checks.find((c) => c.id === 'ask')).toEqual({ id: 'ask', label: 'What is `message`?', kind: 'choice', value: 0.7, choice: 'joke' });
    jev.values = { ask: score(2, { 2: 1 }) };
    const s = await check({ type: 'score', question: 'How risky is `message`?', levels: ['Safe', 'Some risk', 'Reckless'] });
    expect(jev.requests[2]!.questions['ask']).toMatchObject({ type: 'score', criteria: ['Safe', 'Some risk', 'Reckless'] });
    expect(s.checks.find((c) => c.id === 'ask')).toMatchObject({ kind: 'score', value: 2 });
  });

  it('refuses a question Jev cannot be asked and sends nothing', async () => {
    await expect(check({ type: 'choice', question: 'Which?', options: [{ name: 'only', description: '' }] })).rejects.toThrow(/options/);
    await expect(check({ type: 'score', question: 'How much?', levels: ['One'] })).rejects.toThrow(/levels/);
    await expect(check({ type: 'noul', question: '  ', yes: '', no: '' })).rejects.toThrow(/Write the question/);
    expect(jev.requests).toEqual([]);
  });

  it('refuses local-AI-only channels and sends nothing', async () => {
    db.prepare("UPDATE channels SET local_ai_only = 1 WHERE id = 'c1'").run();
    await expect(check()).rejects.toThrow(/local AI only/);
    expect(jev.requests).toEqual([]);
  });
});

describe('Ask Jev over a channel (custom call)', () => {
  it('asks each latest message once, ranks by value, counts failures and caps the range', async () => {
    const archive = new Archive(db);
    archive.ingestMessages(Array.from({ length: 5 }, (_, i) => rawMessage('c1', Date.now() + 1 + i, `msg ${i}`)), ARRIVAL.gateway);
    let n = 0;
    jev.costUsd = 0.00002;
    jev.answer = (req) => {
      const text = (req.state as { message: string }).message;
      if (text.endsWith('msg 2')) throw new Error('down');
      return { ask: { type: 'noul', noul: text.endsWith('msg 4') ? 0.9 : 0.1 + ++n / 100 } };
    };
    const r = await askRange(db, new MessageJudge(db), jev, { channelId: 'c1', question: { type: 'noul', question: 'Is `message` the last one?', yes: '', no: '' }, limit: 4 });
    expect(r.kind).toBe('noul');
    expect(r.asked).toBe(4);
    expect(r.failed).toBe(1);
    expect(r.results[0]!.content).toBe('msg 4');
    expect(r.results).toHaveLength(3);
    expect(r.results.map((x) => x.value)).toEqual([...r.results.map((x) => x.value)].sort((a, b) => b - a));
  });

  it('refuses local-only channels', async () => {
    db.prepare("UPDATE channels SET local_ai_only = 1 WHERE id = 'c1'").run();
    await expect(askRange(db, new MessageJudge(db), jev, { channelId: 'c1', question: { type: 'noul', question: 'q', yes: '', no: '' }, limit: 10 })).rejects.toThrow(/local AI only/);
  });

  it('leaves out a local-only thread of an open channel', async () => {
    const archive = new Archive(db);
    const THREAD = '300000000000000009';
    archive.upsertThreads([{ id: THREAD, name: 'side talk', type: 11, parent_id: 'c1', last_message_id: null }], 0);
    archive.setChannelPolicy(THREAD, { localAiOnly: true });
    archive.ingestMessages([rawMessage(THREAD, Date.now() + 1, 'private thread text')], ARRIVAL.gateway);
    jev.values = { ask: 0.5 };
    const r = await askRange(db, new MessageJudge(db), jev, { channelId: 'c1', question: { type: 'noul', question: 'q', yes: '', no: '' }, limit: 10 });
    expect(r.asked).toBe(1);
    expect(jev.requests.map((q) => (q.state as { message: string }).message).join()).not.toContain('private thread text');
  });

  it('a score question ranks by level and says so', async () => {
    jev.values = { ask: score(1, { 1: 1 }) };
    const r = await askRange(db, new MessageJudge(db), jev, { channelId: 'c1', question: { type: 'score', question: 'How hyped is `message`?', levels: ['Calm', 'Hyped'] }, limit: 1 });
    expect(jev.requests[0]!.questions['ask']).toMatchObject({ type: 'score', criteria: ['Calm', 'Hyped'] });
    expect(r).toMatchObject({ kind: 'score', results: [{ value: 1, choice: null }] });
  });
});
