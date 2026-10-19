// The judge job: Jev re-ranks the chooser's unsure links, never in local-AI-only channels or over the owner's marks; failures wait.
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import * as readers from '@core/reads/archiveReads';
import { MS_PER_MIN } from '@shared/units';
import { snowflakeFromMs, type RawMessage } from '@shared/discord';
import { ARRIVAL } from '@core/arrival';
import type { Archive } from '@core/archive';
import { getSetting, setSetting, type Db } from '@core/db';
import { DEFAULT_WEIGHTS } from '@core/conversations/chooser';
import { CHOOSER_KEY, chooserWeights, type StoredChooser } from '@core/conversations/fit';
import { ConversationLinkJob, LINKER_VERSION } from '@core/conversations/job';
import { CALIBRATION_MIN, calibrateJudge, chooserKey, JUDGE_KEY, judgeQueriesKey, type StoredJudge } from '@core/conversations/judge';
import { ConversationJudgeJob, JUDGE_RETRY_MS } from '@core/conversations/judgeJob';
import { LINK_KIND } from '@core/conversations/linker';
import { markConversation } from '@core/conversations/marks';
import { FakeJev, score, type JevRequest } from './fakeJev';
import { rawMessage, seedArchive, tempDb } from './helpers';

/** Recent, so the messages fall within the judge's 30-day window. */
const T0 = Date.now() - 60 * MS_PER_MIN;
const ann = { id: '100000000000000001', username: 'ann' };
const bob = { id: '100000000000000002', username: 'bob' };
const cy = { id: '100000000000000003', username: 'cy' };
const say = (minute: number, content: string, author: typeof ann): RawMessage => rawMessage('c', T0 + minute * MS_PER_MIN, content, { author });

type Said = { from: string; text: string };
/** Restarting answers the proxy question; everything else is unrelated to everything. */
const proxyAnswer = (req: JevRequest): Record<string, unknown> => {
  const text = (req.state as { message: Said }).message.text;
  const answers: Record<string, unknown> = { responds: { type: 'noul', noul: 0.9 } };
  for (const [id, q] of Object.entries(req.questions)) {
    if (!id.startsWith('relates_')) continue;
    const earlier = (q as unknown as { instructions: { earlier_message: Said } }).instructions.earlier_message.text;
    const hit = text.includes('restarting') && earlier.includes('proxy');
    answers[id] = hit ? score(1.9, { 0: 0, 1: 0.1, 2: 0.9 }) : score(0.5, { 0: 0.5, 1: 0.4, 2: 0.1 });
  }
  return answers;
};

describe('conversation judge job', () => {
  let db: Db;
  let archive: Archive;
  let links: ConversationLinkJob;
  let jev: FakeJev;
  let judge: ConversationJudgeJob;
  const proxy = say(0, 'any tips for proxy settings?', ann);
  const lunch = say(1, 'who wants lunch', cy);
  const restart = say(2, 'try restarting it', bob);
  const noon = say(3, 'sure, noon works', ann);
  const linkOf = (id: string) => db.prepare('SELECT parent_id AS parentId, kind FROM conversation_links WHERE message_id = ?').get(id);
  const asked = () => jev.requests.map((r) => (r.state as { message: Said }).message.text).sort();
  /** Weights that follow Jev's top-level probability alone, for the current chooser and questions. */
  const calibrated = () => setSetting(db, JUDGE_KEY, {
    weights: [0, 0, 1], chooser: chooserKey(chooserWeights(db, LINKER_VERSION)), model: jev.model, queries: judgeQueriesKey(), cases: 100,
  } satisfies StoredJudge);
  const judgeAndRelink = async () => {
    await judge.run();
    await links.run();
  };

  beforeEach(async () => {
    db = tempDb();
    archive = seedArchive(db, [{ id: 'c' }]);
    archive.ingestMessages([proxy, lunch, restart, noon], ARRIVAL.sync);
    links = new ConversationLinkJob(() => db);
    await links.run();
    jev = new FakeJev(proxyAnswer);
    judge = new ConversationJudgeJob(() => db, () => jev, () => links.kick());
  });

  it('asks about unsure links only and relinks the one Jev re-ranks', async () => {
    calibrated();
    expect(linkOf(restart.id)).toEqual({ parentId: lunch.id, kind: LINK_KIND.inferred });
    await judgeAndRelink();
    // The proxy question starts; lunch has one candidate, so its link is certain.
    expect(asked()).toEqual([noon.content, restart.content].sort());
    expect(linkOf(restart.id)).toEqual({ parentId: proxy.id, kind: LINK_KIND.judged });
    // Stored judgments are reused: asking again sends nothing.
    await judgeAndRelink();
    expect(jev.requests).toHaveLength(2);
  });

  it('never asks about a local-AI-only channel or a message the owner marked', async () => {
    calibrated();
    markConversation(db, noon.id, noon.id, 'belongs');
    await links.run();
    await judgeAndRelink();
    expect(asked()).toEqual([restart.content]);
    archive.setChannelPolicy('c', { localAiOnly: true, textTier: 'full' });
    db.exec('DELETE FROM conversation_judgments');
    jev.requests = [];
    await judgeAndRelink();
    expect(jev.requests).toEqual([]);
  });

  it('rechecks owner marks written while the background candidate read is in flight', async () => {
    calibrated();
    const original = readers.readHost;
    let selected!: () => void;
    let release!: () => void;
    const selection = new Promise<void>((resolve) => { selected = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(readers, 'readHost').mockImplementation(async (...args) => {
      const batch = await original(...args);
      selected();
      await gate;
      return batch as never;
    });
    onTestFinished(() => spy.mockRestore());
    const running = judge.run();
    await selection;
    markConversation(db, noon.id, noon.id, 'belongs');
    release();
    await running;
    expect(asked()).toEqual([restart.content]);
  });

  it('waits a day after a failure, and asks again when the texts it judged change', async () => {
    calibrated();
    jev.fail = true;
    await judgeAndRelink();
    expect(jev.requests).toHaveLength(2);
    jev.fail = false;
    await judgeAndRelink();
    expect(jev.requests).toHaveLength(2);
    db.prepare('UPDATE conversation_judgments SET failed_at = ?').run(Date.now() - JUDGE_RETRY_MS - 1);
    await judgeAndRelink();
    expect(jev.requests).toHaveLength(4);
    expect(linkOf(restart.id)).toEqual({ parentId: proxy.id, kind: LINK_KIND.judged });
    // An edit to a judged candidate makes the judgment stale: the chooser's link until Jev is asked again.
    archive.ingestMessages([{ ...proxy, content: 'any tips for vpn settings?', edited_timestamp: new Date(T0 + 10 * MS_PER_MIN).toISOString() }], ARRIVAL.gateway);
    await links.run();
    expect(linkOf(restart.id)).toEqual({ parentId: lunch.id, kind: LINK_KIND.inferred });
  });

  it('stays off without enough held-out replies to calibrate, asking nothing', async () => {
    await judgeAndRelink();
    expect(jev.requests).toEqual([]);
    expect(getSetting(db, JUDGE_KEY)).toBeUndefined();
  });

  it('stops when Jev is switched off', async () => {
    calibrated();
    const off = new ConversationJudgeJob(() => db, () => null, () => links.kick());
    await off.run();
    expect(jev.requests).toEqual([]);
  });
});

describe('judge calibration', () => {
  const T1 = Date.now() - 24 * 60 * MS_PER_MIN;
  const TOPICS = 60;
  /** Minutes between topics: three questions, then their three answers. */
  const TOPIC_MIN = 12;
  const users = [ann, bob, cy, { id: '100000000000000004', username: 'dee' }];
  const at = (min: number, n: number, content: string, extra: Partial<RawMessage>): RawMessage =>
    rawMessage('c', T1 + min * MS_PER_MIN, content, { id: (BigInt(snowflakeFromMs(T1 + min * MS_PER_MIN)) + BigInt(n)).toString(), ...extra });
  /** Per topic, three questions by ann, then three people each answering one by reply: the chooser is unsure which. */
  const topics = (): RawMessage[] => Array.from({ length: TOPICS }, (_, t) => {
    const qs = [0, 1, 2].map((k) => at(t * TOPIC_MIN + k, k, `topic${t}x${k} question?`, { author: ann }));
    return [...qs, ...qs.map((q, k) => at(t * TOPIC_MIN + 3 + k, k, `reply ${t} ${k}`,
      { author: users[k + 1], type: 19, message_reference: { message_id: q.id } } as Partial<RawMessage>))];
  }).flat();
  /** Rates the question an answer replies to as responded to. */
  const matching = (req: JevRequest): Record<string, unknown> => {
    const [, t, k] = (req.state as { message: Said }).message.text.split(' ');
    const answers: Record<string, unknown> = { responds: { type: 'noul', noul: 0.9 } };
    for (const [id, q] of Object.entries(req.questions)) {
      if (!id.startsWith('relates_')) continue;
      const hit = (q as unknown as { instructions: { earlier_message: Said } }).instructions.earlier_message.text.startsWith(`topic${t}x${k} `);
      answers[id] = hit ? score(1.9, { 0: 0, 1: 0.1, 2: 0.9 }) : score(0.2, { 0: 0.8, 1: 0.15, 2: 0.05 });
    }
    return answers;
  };
  let db: Db;

  beforeEach(async () => {
    db = tempDb();
    seedArchive(db, [{ id: 'c' }]).ingestMessages(topics(), ARRIVAL.sync);
    await new ConversationLinkJob(() => db).run();
  });

  it('retries a failing Jev a day later, then fits on held-out replies and judges', async () => {
    const jev = new FakeJev(matching);
    const judge = new ConversationJudgeJob(() => db, () => jev, () => undefined);
    jev.fail = true;
    await judge.run();
    const asked = jev.requests.length;
    expect(asked).toBeGreaterThanOrEqual(CALIBRATION_MIN);
    await judge.run();
    expect(jev.requests).toHaveLength(asked);
    // Switching it off and on again retries at once.
    judge.stop();
    jev.fail = false;
    await judge.run();
    expect(getSetting(db, JUDGE_KEY)).toMatchObject({ model: jev.model, chooser: chooserKey(chooserWeights(db, LINKER_VERSION)), queries: judgeQueriesKey() });
    expect((getSetting(db, JUDGE_KEY) as StoredJudge).cases).toBeGreaterThanOrEqual(CALIBRATION_MIN);
  });

  it('calibrates again after a refit moves the held-out boundary, even with the same weights', async () => {
    const jev = new FakeJev(matching);
    const judge = new ConversationJudgeJob(() => db, () => jev, () => undefined);
    const legacy: StoredChooser = { weights: [...DEFAULT_WEIGHTS], replies: 0, linkerVersion: LINKER_VERSION };
    setSetting(db, CHOOSER_KEY, legacy);
    await judge.run();
    expect(jev.requests).toEqual([]);
    setSetting(db, CHOOSER_KEY, { ...legacy, sampleFromTs: Date.now() } satisfies StoredChooser);
    await judge.run();
    expect(getSetting(db, JUDGE_KEY)).toMatchObject({ model: jev.model });
  });

  it('calibrates only on replies older than every reply the chooser was fitted on', async () => {
    const jev = new FakeJev(matching);
    const fit = (sampleFromTs?: number): StoredChooser => ({ weights: [...DEFAULT_WEIGHTS], replies: 0, linkerVersion: LINKER_VERSION, ...(sampleFromTs ? { sampleFromTs } : {}) });
    // Half the topics are older than the sample: too few cases, so nothing is asked.
    expect(await calibrateJudge(db, jev, fit(T1 + (TOPICS / 2) * TOPIC_MIN * MS_PER_MIN))).toBe('too-few');
    // A fit that predates the boundary has no honest held-out replies.
    expect(await calibrateJudge(db, jev, fit())).toBe('too-few');
    expect(jev.requests).toEqual([]);
    expect(await calibrateJudge(db, jev, undefined)).toBe('fitted');
  });
});
