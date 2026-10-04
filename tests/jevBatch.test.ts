// Re-runs and catch-up judge many messages per Jev request. Jev's questions run independently, so each carries its own
// message's state in its instructions and the request's state is empty; answers land on the right message.
import { describe, expect, it } from 'vitest';
import type { Question } from '../src/core/ai/decisions';
import { ARRIVAL } from '../src/core/arrival';
import { BATCH_STATE, batchKey, carriedQuestion } from '../src/core/jev/messageBatch';
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

/** The message a question is about: the one it carries, or the request's state's when asked alone. */
const about = (req: JevRequest, q: Question): string => (q.instructions as { message?: string }).message ?? (req.state as { message: string }).message;
/** Jev stand-in answering message i with i / 100, read from the message the question is about. */
const byNumber = (req: JevRequest) =>
  Object.fromEntries(Object.entries(req.questions).map(([k, q]) => [k, { type: 'noul', noul: Number(/number (\d+)$/.exec(about(req, q))![1]) / 100 }]));

const stored = (db: ReturnType<typeof tempDb>, id: string) => db.prepare('SELECT value FROM jev_judgments WHERE message_id = ? AND subject = ?').pluck().get(id, SUBJECT);

describe('batched Jev judgments', () => {
  it("give each question its own message's state beside its text, and the request an empty state", async () => {
    const { db, messages, judge, items } = setup(60);
    const jev = new FakeJev(byNumber);
    const r = await judge.judgeMany(jev, items);

    expect(jev.requests.length).toBeLessThan(messages.length / 10);
    const first = jev.requests[0]!;
    expect(first.state).toEqual(BATCH_STATE);
    expect(first.questions[batchKey(SUBJECT, messages[1]!.id)]).toEqual({
      ...QUESTION,
      instructions: { earlier: [expect.stringMatching(/number 0$/)], message: expect.stringMatching(/number 1$/), question: QUESTION.instructions },
    });
    messages.forEach((m, i) => {
      expect(r.answers.get(m.id)?.[SUBJECT]).toEqual({ type: 'noul', noul: i / 100 });
      expect(stored(db, m.id)).toBe(i / 100);
    });
  });

  it('asks a message alone when a question names no field it could carry', async () => {
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

describe('a question carrying its message', () => {
  const state = { earlier: [], message: 'ann: hi' };
  it("sets the message's state beside the question text, keeping values already carried there", () => {
    expect(carriedQuestion({ type: 'score', instructions: 'How urgent is `message`?', criteria: ['calm', 'urgent'] }, state)).toMatchObject({
      instructions: { ...state, question: 'How urgent is `message`?' },
    });
    const withVars: Question = { type: 'choice', instructions: { topic: 'keyboards', question: 'Is `message` about `topic`?' }, criteria: { yes: null, no: null } };
    expect(carriedQuestion(withVars, state)).toEqual({ ...withVars, instructions: { ...state, topic: 'keyboards', question: 'Is `message` about `topic`?' } });
  });

  it("can't carry it when the question names no state field, has no question text, or already uses a field's name", () => {
    expect(carriedQuestion({ type: 'noul', instructions: 'Is this a question?' }, state)).toBeNull();
    expect(carriedQuestion({ type: 'noul', instructions: ['Is `message` a question?'] }, state)).toBeNull();
    expect(carriedQuestion({ type: 'noul', instructions: { message: 'x', question: 'Is `message` a question?' } }, state)).toBeNull();
  });
});
