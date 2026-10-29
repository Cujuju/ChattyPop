// Every host Jev request is checked against local-AI-only when it is sent, not only when it is queued: a channel switched
// to local AI only while its request waits for a slot is never read by Jev, and the refusal is not a failure.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rule } from '@shared/rules';
import { newRuleInput } from '@shared/ruleSpec';
import type { DecisionProvider, Question } from '../src/core/ai/decisions';
import { JEV_MAX_IN_FLIGHT, JevProvider, openRouterJevRoute } from '../src/core/ai/jev';
import { scopedDecider } from '../src/core/ai/readScope';
import type { Archive } from '../src/core/archive';
import { ARRIVAL, type TextMessage } from '../src/core/arrival';
import { suggestChannels } from '../src/core/channelSuggestions';
import type { Db } from '../src/core/db';
import { askRange } from '../src/core/jev/askRange';
import { checkMessage } from '../src/core/jev/messageCheck';
import { judgeMessage } from '../src/core/conversations/judge';
import { CANDIDATE_MAX } from '../src/core/conversations/linker';
import { channelReach, contextInputs, messageInput } from '../src/core/conversations/store';
import { MessageJudge } from '../src/core/jev/messageJudge';
import { textMessage } from '../src/core/queries/messageText';
import { rawMessage, seedArchive, settleAsync, tempDb } from './helpers';

const OPEN = '200000000000000002';
const PRIVATE = '200000000000000001';
const SECRET = 'confidential';
const QUESTION: Question = { type: 'noul', instructions: 'Is `message` about trading?' };

let db: Db;
let archive: Archive;
let jev: DecisionProvider;
/** Each request body Jev received, and the answers it still holds. */
let sent: string[];
let held: (() => void)[];

beforeEach(() => {
  db = tempDb();
  archive = seedArchive(db, [{ id: OPEN }, { id: PRIVATE }]);
  sent = [];
  held = [];
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    sent.push(init.body);
    return new Promise((answer) => held.push(() => answer({ ok: true, status: 200, headers: new Headers(), json: async () => ({ answers: {} }) })));
  });
  jev = new JevProvider(() => undefined).via(openRouterJevRoute({ id: 'k', label: 'K', key: 'sk', hint: '…', models: [], anyModel: true }));
});
afterEach(() => vi.unstubAllGlobals());

let seq = 0;
const message = (channelId: string, content: string): TextMessage => {
  const raw = rawMessage(channelId, Date.now() - 1000 + ++seq, content);
  archive.ingestMessages([raw], ARRIVAL.gateway);
  return textMessage(db, raw.id)!;
};

/**
 * Fills every Jev slot, starts `queue` (whose requests wait for one), turns PRIVATE local-only when `flip`, then frees the
 * slots. Returns whether PRIVATE's text reached Jev.
 */
async function queued(queue: () => Promise<unknown>, flip: boolean): Promise<boolean> {
  sent = [];
  for (let i = 0; i < JEV_MAX_IN_FLIGHT; i++) void jev.decide({ state: `filler ${i}`, questions: { q: QUESTION } });
  await settleAsync();
  const work = queue().catch(() => undefined);
  await settleAsync();
  expect(sent).toHaveLength(JEV_MAX_IN_FLIGHT); // the private request waits for a slot
  if (flip) archive.setChannelPolicy(PRIVATE, { localAiOnly: true, textTier: null });
  while (held.length) {
    held.shift()!();
    await settleAsync();
  }
  await work;
  return sent.some((body) => body.includes(SECRET));
}

/** Each path, asked once with PRIVATE open (it reaches Jev) and once turned local-only while queued (it never does). */
const paths: [string, (m: TextMessage) => Promise<unknown>][] = [
  ['a single judgment', (m) => new MessageJudge(db).judgeNow(jev, m, { q: QUESTION })],
  ['a live judgment', (m) => new Promise<void>((done) => void new MessageJudge(db).judge(jev, m, { q: QUESTION }, () => done(), () => done()))],
  ['a right-click check', (m) => checkMessage(db, new MessageJudge(db), jev, m.id, null)],
  [
    'a range ask',
    () => askRange(db, new MessageJudge(db), jev, { channelId: PRIVATE, question: { type: 'noul', question: 'Is `message` news?', yes: '', no: '' }, limit: 1 }),
  ],
  [
    'a channel suggestion',
    (m) => {
      const rule: Rule = { ...newRuleInput(), id: 1, name: 'gaming', position: 1, armedAt: 0, createdAt: 0, builtin: null, group: null, error: null, fired: 0, lastFiredAt: null };
      return suggestChannels(scopedDecider(jev, () => db), [rule], [{ channelId: PRIVATE, channelName: 'family', messages: [{ author: 'x', content: m.content }] }]);
    },
  ],
];

describe('a queued host Jev request after its channel turns local-AI-only', () => {
  for (const [name, ask] of paths) {
    it(`${name} is never sent`, async () => {
      expect(await queued(() => ask(message(PRIVATE, `${SECRET} open`)), false)).toBe(true);
      expect(await queued(() => ask(message(PRIVATE, `${SECRET} queued`)), true)).toBe(false);
    });
  }

  it('a batch drops the private message and still asks the others', async () => {
    const items = () => [message(OPEN, 'public'), message(PRIVATE, SECRET)].map((m) => ({ m, questions: { q: QUESTION }, certain: {} }));
    expect(await queued(() => new MessageJudge(db).judgeMany(jev, items()), false)).toBe(true);
    expect(await queued(() => new MessageJudge(db).judgeMany(jev, items()), true)).toBe(false);
    expect(sent.some((body) => body.includes('public'))).toBe(true);
  });

  it('is refused, not failed: certain answers stored, live judgment answers, range ask and reply judging skip it', async () => {
    const certain = { settled: { type: 'noul', noul: 1 } } as const;
    const judge = new MessageJudge(db);
    let batch: Awaited<ReturnType<MessageJudge['judgeMany']>> | undefined;
    const items = [message(OPEN, 'public'), message(PRIVATE, SECRET)].map((m) => ({ m, questions: { q: QUESTION }, certain }));
    expect(await queued(async () => (batch = await judge.judgeMany(jev, items)), true)).toBe(false);
    const privateId = items[1]!.m.id;
    expect(batch!.failed.has(privateId)).toBe(false);
    expect(batch!.answers.get(privateId)).toEqual(certain);
    expect(db.prepare('SELECT subject FROM jev_judgments WHERE message_id = ?').pluck().all(privateId)).toEqual(['settled']);

    archive.setChannelPolicy(PRIVATE, { localAiOnly: false, textTier: null });
    let outcome = '';
    const live = message(PRIVATE, SECRET);
    const judged = () => new Promise<void>((done) => void judge.judge(jev, live, { q: QUESTION }, () => done(void (outcome = 'answered')), () => done(void (outcome = 'failed'))));
    expect(await queued(judged, true)).toBe(false);
    expect(outcome).toBe('answered');

    archive.setChannelPolicy(PRIVATE, { localAiOnly: false, textTier: null });
    message(PRIVATE, SECRET);
    let ranked: Awaited<ReturnType<typeof askRange>> | undefined;
    const question = { type: 'noul', question: 'Is `message` news?', yes: '', no: '' } as const;
    expect(await queued(async () => (ranked = await askRange(db, judge, jev, { channelId: PRIVATE, question, limit: 1 })), true)).toBe(false);
    expect(ranked).toMatchObject({ asked: 0, failed: 0 });

    archive.setChannelPolicy(PRIVATE, { localAiOnly: false, textTier: null });
    message(PRIVATE, 'who has one?');
    const reply = messageInput(db, message(PRIVATE, SECRET).id)!;
    const candidates = contextInputs(db, PRIVATE, reply, channelReach(db, PRIVATE), CANDIDATE_MAX);
    expect(candidates.length).toBeGreaterThan(0);
    let linked: Awaited<ReturnType<typeof judgeMessage>> | undefined;
    expect(await queued(async () => (linked = await judgeMessage(db, jev, reply, PRIVATE, candidates)), true)).toBe(false);
    expect(linked).toBeNull();
    expect(db.prepare('SELECT COUNT(*) FROM conversation_judgments WHERE message_id = ?').pluck().get(reply.id)).toBe(0);
  });
});
