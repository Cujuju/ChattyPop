// Re-runs and catch-up judge many messages per Jev request. Jev judges only the state, so the batched state holds each
// message's own state under a key, each question points at its message's key, and answers land on the right message.
import { describe, expect, it } from 'vitest';
import type { Question } from '../src/core/ai/decisions';
import { ARRIVAL } from '../src/core/arrival';
import { batchKey, scopedQuestion } from '../src/core/jev/messageBatch';
import { MessageJudge } from '../src/core/jev/messageJudge';
import { textMessage } from '../src/core/queries/messageText';
import type { JevRequest } from './fakeJev';
import { FakeJev } from './fakeJev';
import { rawMessage, seedArchive, tempDb } from './helpers';

const QUESTION: Question = { type: 'noul', instructions: 'Is `message` about trading? Read `earlier` only to understand `message`.', criteria: { true: '`message` is about trading.', false: 'It is not.' } };
const SUBJECT = 'class:trading';

function setup(n: number) {
  const db = tempDb();
  const archive = seedArchive(db, [{ id: 'c1' }, { id: 'c2' }]);
  db.prepare("UPDATE channels SET local_ai_only = 1 WHERE id = 'c2'").run();
  const t0 = Date.now() - 1000 * n;
  const raws = Array.from({ length: n }, (_, i) => rawMessage('c1', t0 + i, `message number ${i}`));
  archive.ingestMessages(raws, ARRIVAL.sync);
  const messages = raws.map((r) => textMessage(db, r.id)!);
  return { db, messages, judge: new MessageJudge(db), items: messages.map((m) => ({ m, questions: { [SUBJECT]: QUESTION }, certain: {} })) };
}

/** The message a question is about: the state entry its `mN.message` path names, or the whole state when asked alone. */
function about(req: JevRequest, q: Question): string {
  const path = /`(m\d+)\.message`/.exec(JSON.stringify(q.instructions));
  const state = req.state as Record<string, { message: string }> & { message?: string };
  return path ? state[path[1]!]!.message : state.message!;
}
/** Jev stand-in answering message i with i / 100, read from the state the question points at. */
const byNumber = (req: JevRequest) =>
  Object.fromEntries(Object.entries(req.questions).map(([k, q]) => [k, { type: 'noul', noul: Number(/number (\d+)$/.exec(about(req, q))![1]) / 100 }]));

const stored = (db: ReturnType<typeof tempDb>, id: string) => db.prepare('SELECT value FROM jev_judgments WHERE message_id = ? AND subject = ?').pluck().get(id, SUBJECT);

describe('batched Jev judgments', () => {
  it('put each message in the state under its own key, and point its questions there', async () => {
    const { db, messages, judge, items } = setup(60);
    const jev = new FakeJev(byNumber);
    const r = await judge.judgeMany(jev, items);

    expect(jev.requests.length).toBeLessThan(messages.length / 10);
    const first = jev.requests[0]!;
    expect(Object.keys(first.state as object).slice(0, 2)).toEqual(['m1', 'm2']);
    expect((first.state as Record<string, unknown>)['m1']).toMatchObject({ message: expect.stringMatching(/number 0$/), earlier: [] });
    expect(first.questions[batchKey(SUBJECT, messages[1]!.id)]).toMatchObject({
      instructions: 'Is `m2.message` about trading? Read `m2.earlier` only to understand `m2.message`.',
      criteria: { true: '`m2.message` is about trading.', false: 'It is not.' },
    });
    messages.forEach((m, i) => {
      expect(r.answers.get(m.id)?.[SUBJECT]).toEqual({ type: 'noul', noul: i / 100 });
      expect(stored(db, m.id)).toBe(i / 100);
    });
  });

  it('asks a message alone when a question names no field it could be pointed at', async () => {
    const { messages, judge, items } = setup(3);
    const plain: Question = { type: 'noul', instructions: 'Is this about trading?' };
    const jev = new FakeJev(byNumber);
    const r = await judge.judgeMany(jev, [{ ...items[0]!, questions: { [SUBJECT]: plain } }, ...items.slice(1)]);

    const solo = jev.requests.find((q) => Object.keys(q.questions).includes(SUBJECT))!;
    expect((solo.state as { message: string }).message).toMatch(/number 0$/);
    expect(r.answers.get(messages[0]!.id)?.[SUBJECT]).toEqual({ type: 'noul', noul: 0 });
    expect(r.answers.get(messages[2]!.id)?.[SUBJECT]).toEqual({ type: 'noul', noul: 0.02 });
  });

  it('never sends a request without questions, wherever an unscopable message falls', async () => {
    for (const at of [0, 24, 25, 26, 49]) {
      const { judge, items } = setup(50);
      const plain: Question = { type: 'noul', instructions: 'Is this about trading?' };
      const jev = new FakeJev(byNumber);
      const r = await judge.judgeMany(jev, items.map((it, i) => (i === at ? { ...it, questions: { [SUBJECT]: plain } } : it)));
      expect(jev.requests.every((q) => Object.keys(q.questions).length > 0)).toBe(true);
      expect(r.answers.size).toBe(50);
    }
  });

  it('asks a failed batch one message at a time, and never sends a local-AI-only message', async () => {
    const { db, messages, judge, items } = setup(5);
    const local = { ...items[0]!, m: { ...items[0]!.m, channelId: 'c2' }, certain: { settled: { type: 'noul' as const, noul: 1 } } };
    // Jev refuses any request about message 3 (as it refuses invalid text), so only that one fails.
    const jev = new FakeJev((req) => {
      if (Object.values(req.questions).some((q) => about(req, q).endsWith('number 3'))) throw new Error('HTTP 400');
      return byNumber(req);
    });
    const r = await judge.judgeMany(jev, [local, ...items.slice(1)]);

    expect(jev.requests.flatMap((q) => Object.values(q.questions).map((x) => about(q, x))).some((t) => t.endsWith('number 0'))).toBe(false);
    expect(r.answers.get(messages[0]!.id)).toEqual({ settled: { type: 'noul', noul: 1 } });
    expect([...r.failed]).toEqual([messages[3]!.id]);
    for (const i of [1, 2, 4]) expect(stored(db, messages[i]!.id)).toBe(i / 100);
  });
});

describe('scoping a question to one message of a batch', () => {
  it('points field references at the key and leaves values carried beside the question alone', () => {
    const withVars: Question = { type: 'choice', instructions: { topic: 'the `message` field of a bot', question: 'Is `message` about `topic`?' }, criteria: { yes: '`replying_to` agrees', no: null } };
    expect(scopedQuestion(withVars, 'm7')).toEqual({
      type: 'choice',
      instructions: { topic: 'the `message` field of a bot', question: 'Is `m7.message` about `topic`?' },
      criteria: { yes: '`m7.replying_to` agrees', no: null },
    });
    expect(scopedQuestion({ type: 'score', instructions: 'How urgent is `message`?', criteria: ['calm', 'urgent'] }, 'm1')).toMatchObject({ instructions: 'How urgent is `m1.message`?' });
    expect(scopedQuestion({ type: 'noul', instructions: 'Is this a question?' }, 'm1')).toBeNull();
  });
});
