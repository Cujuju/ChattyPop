// Conversation links: the rules and the chooser on their own, then the background job and the scorer over a real archive.
import { describe, expect, it } from 'vitest';
import { MS_PER_HOUR, MS_PER_MIN } from '@shared/units';
import { ARRIVAL } from '@core/arrival';
import { getSetting, type Db } from '@core/db';
import { choose, DEFAULT_WEIGHTS, fitSample, fitWeights } from '@core/conversations/chooser';
import { FEATURE_COUNT, FEATURES, topicWords } from '@core/conversations/features';
import { FIT_MIN_REPLIES, storedChooser } from '@core/conversations/fit';
import { LINK_KIND, LINK_MIN_CONFIDENCE, linkMessages, type LinkInput } from '@core/conversations/linker';
import { ConversationLinkJob, LINKER_VERSION, LINKER_VERSION_KEY } from '@core/conversations/job';
import { channelReach, REACH_FALLBACK_MS, REACH_MIN_REPLIES } from '@core/conversations/store';
import { isHeldOut, scoreReplyHoldout } from '@core/conversations/score';
import { PUBLIC_THREAD_TYPE, type RawMessage } from '@shared/discord';
import { rawMessage, seedArchive, tempDb } from './helpers';

const T0 = Date.UTC(2026, 8, 1, 12);
const REACH = 10 * MS_PER_MIN;
const msg = (id: string, authorId: string, minute: number, text = '', extra: Partial<LinkInput> = {}): LinkInput => ({
  id, authorId, ts: T0 + minute * MS_PER_MIN, replyTo: null, mentions: [], repliesToAuthor: null,
  words: topicWords(text), question: text.includes('?'), text, ...extra,
});
const link = (before: LinkInput[], messages: LinkInput[], options = {}) =>
  linkMessages(before, messages, { reachMs: REACH, weights: DEFAULT_WEIGHTS, thread: { firstId: 't1', starterId: 'starter' } }, options);
const kinds = (before: LinkInput[], messages: LinkInput[], options = {}) => link(before, messages, options).map((l) => [l.messageId, l.parentId, l.kind]);

describe('linker', () => {
  it('decides replies, a thread start, mentions and the author continuing by rule', () => {
    expect(kinds([], [
      msg('t1', 'ann', 0),
      msg('b1', 'bob', 1),
      msg('b2', 'bob', 2),
      msg('c1', 'cy', 3, '', { mentions: ['ann'] }),
      msg('d1', 'dee', 4, '', { replyTo: 'b1' }),
    ])).toEqual([
      ['t1', 'starter', LINK_KIND.thread],
      ['b1', 't1', LINK_KIND.inferred],
      ['b2', 'b1', LINK_KIND.continuation],
      ['c1', 't1', LINK_KIND.mention],
      ['d1', 'b1', LINK_KIND.reply],
    ]);
  });

  it('chooses the candidate the message shares a topic with over the newer ones', () => {
    const [chosen] = link([msg('q', 'ann', 0, 'anyone know about proxy settings?'), msg('x', 'cy', 1, 'lunch anyone'), msg('y', 'dee', 2, 'nice weather today')],
      [msg('m', 'bob', 3, 'proxy settings live under network')]);
    expect(chosen).toMatchObject({ parentId: 'q', kind: LINK_KIND.inferred });
    expect(chosen!.confidence).toBeGreaterThanOrEqual(LINK_MIN_CONFIDENCE);
  });

  it('starts a conversation when no candidate is likely enough (keeping the declined confidence) or none is within reach', () => {
    const crowd = Array.from({ length: 10 }, (_, i) => msg(`p${i}`, `u${i}`, i * 0.5));
    const [unsure] = link(crowd, [msg('m', 'zed', 5)]);
    expect(unsure).toMatchObject({ parentId: null, kind: LINK_KIND.start });
    expect(unsure!.confidence).toBeGreaterThan(0);
    expect(unsure!.confidence).toBeLessThan(LINK_MIN_CONFIDENCE);
    expect(link([msg('old', 'ann', 0)], [msg('m', 'bob', 30)])).toEqual([{ messageId: 'm', parentId: null, kind: LINK_KIND.start, confidence: 0 }]);
  });

  it('hides replies when scoring', () => {
    expect(kinds([msg('b1', 'bob', 0)], [msg('d1', 'dee', 1, '', { replyTo: 'b1' })], { hideReplies: true })).toEqual([['d1', 'b1', LINK_KIND.inferred]]);
  });
});

describe('chooser fit', () => {
  it('learns what the replies show and keeps the prior for a feature that never varies', () => {
    let seed = 7;
    const random = (): number => (seed = (seed * 48_271) % 2_147_483_647) / 2_147_483_647;
    const example = () => {
      const parent = Math.floor(random() * 5);
      const candidates = Array.from({ length: 5 }, (_, i) => msg(`c${i}`, `u${i}`, i, i === parent ? 'deploy pipeline' : `other${i} stuff`));
      return { m: msg('m', 'zed', 5, 'deploy pipeline broke'), candidates, parent };
    };
    const zeros = new Array<number>(FEATURE_COUNT).fill(0);
    const w = fitWeights(Array.from({ length: 600 }, example).map((e) => fitSample(e.m, e.candidates, e.parent)), zeros);
    expect(w[FEATURES.indexOf('sharedWords')]).toBeGreaterThan(1);
    expect(w[FEATURES.indexOf('mentionsAuthor')]).toBe(0);
    const held = Array.from({ length: 200 }, example);
    expect(held.filter((e) => choose(e.m, e.candidates, w).index === e.parent).length / held.length).toBeGreaterThan(0.95);
  });
});

const ann = { id: '100000000000000001', username: 'ann' };
const bob = { id: '100000000000000002', username: 'bob' };
const cy = { id: '100000000000000003', username: 'cy' };
const say = (channel: string, minute: number, content: string, author = ann, extra: Partial<RawMessage> = {}): RawMessage =>
  rawMessage(channel, T0 + minute * MS_PER_MIN, content, { author, ...extra });
const replyTo = (parent: RawMessage): Partial<RawMessage> => ({ type: 19, message_reference: { message_id: parent.id } } as Partial<RawMessage>);
const linksOf = (db: Db) => new Map((db.prepare('SELECT message_id AS id, parent_id AS parentId, kind FROM conversation_links').all() as
  { id: string; parentId: string | null; kind: string }[]).map((r) => [r.id, [r.parentId, r.kind]]));
const queued = (db: Db) => db.prepare('SELECT COUNT(*) FROM conversation_link_queue').pluck().get();
/** `count` question-and-answer pairs, ten minutes apart. */
const pairs = (count: number): RawMessage[] => Array.from({ length: count }, (_, i) => {
  const asked = say('c', i * 10, `question ${i}?`);
  // The answer's id low bits (Discord's per-process counter) alternate, so both halves of the score's split occur.
  const answer = say('c', i * 10 + 1, `answer ${i}`, bob, replyTo(asked));
  return [asked, { ...answer, id: (BigInt(answer.id) + BigInt(i)).toString() }];
}).flat();

describe('conversation link job', () => {
  it('links what ingest queues, relinks when older history arrives, and empties the queue', async () => {
    const db = tempDb();
    const archive = seedArchive(db, [{ id: 'c' }]);
    const job = new ConversationLinkJob(() => db);
    const q = say('c', 0, 'any tips for proxy settings?');
    const a = say('c', 2, 'check the network panel', bob, replyTo(q));
    const late = say('c', 3, 'thanks, that worked');
    archive.ingestMessages([q, a, late], ARRIVAL.gateway);
    await job.run();
    expect(linksOf(db).get(late.id)).toEqual([a.id, LINK_KIND.inferred]);
    expect(linksOf(db).get(a.id)).toEqual([q.id, LINK_KIND.reply]);
    // A history page delivers a question to her just before: the message after it is relinked.
    const between = say('c', 2.5, `<@${ann.id}> did the proxy settings work?`, cy);
    archive.ingestMessages([between], ARRIVAL.sync);
    await job.run();
    expect(linksOf(db).get(late.id)).toEqual([between.id, LINK_KIND.inferred]);
    expect(queued(db)).toBe(0);
  });

  it('relinks an edited message whose new text mentions someone', async () => {
    const db = tempDb();
    const archive = seedArchive(db, [{ id: 'c' }]);
    const job = new ConversationLinkJob(() => db);
    const b = say('c', 0, 'hi', bob);
    const c = say('c', 1, 'unrelated', cy);
    const a = say('c', 2, 'thoughts?');
    archive.ingestMessages([b, c, a], ARRIVAL.gateway);
    await job.run();
    expect(linksOf(db).get(a.id)).toEqual([c.id, LINK_KIND.inferred]);
    archive.ingestMessages([{ ...a, content: `thoughts <@${bob.id}>?`, edited_timestamp: new Date(T0 + 3 * MS_PER_MIN).toISOString() }], ARRIVAL.gateway);
    await job.run();
    expect(linksOf(db).get(a.id)).toEqual([b.id, LINK_KIND.mention]);
  });

  it('links a thread to the message it was started from', async () => {
    const db = tempDb();
    const archive = seedArchive(db, [{ id: 'c' }]);
    const job = new ConversationLinkJob(() => db);
    const starter = say('c', 0, 'start a thread here');
    archive.ingestMessages([starter], ARRIVAL.gateway);
    archive.upsertThreads([{ id: starter.id, name: 'thread', type: PUBLIC_THREAD_TYPE, parent_id: 'c', last_message_id: null }], T0);
    const first = say(starter.id, 1, 'in the thread', bob);
    archive.ingestMessages([first], ARRIVAL.gateway);
    await job.run();
    expect(linksOf(db).get(first.id)).toEqual([starter.id, LINK_KIND.thread]);
  });

  it("measures a channel's reach from its own reply delays, else the archive's, else the fallback", async () => {
    const db = tempDb();
    const archive = seedArchive(db, [{ id: 'slow' }, { id: 'quiet' }]);
    const job = new ConversationLinkJob(() => db);
    expect(channelReach(db, 'slow')).toBe(REACH_FALLBACK_MS);
    const messages: RawMessage[] = [];
    for (let i = 0; i < REACH_MIN_REPLIES; i++) {
      const asked = say('slow', i * 300, `question ${i}`);
      messages.push(asked, say('slow', i * 300 + 60, `answer ${i}`, bob, replyTo(asked)));
    }
    archive.ingestMessages(messages, ARRIVAL.sync);
    await job.run();
    expect(channelReach(db, 'slow')).toBe(MS_PER_HOUR);
    expect(channelReach(db, 'quiet')).toBe(MS_PER_HOUR);
  });

  it('queues every channel once per linker version', () => {
    const db = tempDb();
    const archive = seedArchive(db, [{ id: 'c' }]);
    archive.ingestMessages([say('c', 0, 'one')], ARRIVAL.gateway);
    db.exec('DELETE FROM conversation_link_queue');
    const job = new ConversationLinkJob(() => db);
    job.start();
    expect(getSetting(db, LINKER_VERSION_KEY)).toBe(LINKER_VERSION);
    expect(db.prepare('SELECT channel_id FROM conversation_link_queue').pluck().all()).toEqual(['c']);
  });

  it('fits the chooser at the next start once enough replies are stored, then only when they double', async () => {
    const db = tempDb();
    const archive = seedArchive(db, [{ id: 'c' }]);
    archive.ingestMessages(pairs(FIT_MIN_REPLIES), ARRIVAL.sync);
    await new ConversationLinkJob(() => db).run();
    expect(storedChooser(db, LINKER_VERSION)).toBeUndefined();
    await new ConversationLinkJob(() => db).run();
    expect(storedChooser(db, LINKER_VERSION)).toMatchObject({ replies: FIT_MIN_REPLIES, linkerVersion: LINKER_VERSION });
    expect(queued(db)).toBe(0);
    db.exec(`UPDATE settings SET value = json_set(value, '$.weights[0]', 9) WHERE key = 'conversations.chooser'`);
    await new ConversationLinkJob(() => db).run();
    expect(storedChooser(db, LINKER_VERSION)!.weights[0]).toBe(9);
    // The oldest fitted reply (the first answer) bounds the judge's held-out replies; a fit without it is refitted.
    expect(storedChooser(db, LINKER_VERSION)!.sampleFromTs).toBe(T0 + MS_PER_MIN);
    db.exec(`UPDATE settings SET value = json_remove(value, '$.sampleFromTs') WHERE key = 'conversations.chooser'`);
    await new ConversationLinkJob(() => db).run();
    expect(storedChooser(db, LINKER_VERSION)).toMatchObject({ sampleFromTs: T0 + MS_PER_MIN });
    expect(storedChooser(db, LINKER_VERSION)!.weights[0]).not.toBe(9);
  });

  it('reports the channels each run linked when the queue empties', async () => {
    const db = tempDb();
    const archive = seedArchive(db, [{ id: 'c' }, { id: 'd' }]);
    const runs: string[][] = [];
    const job = new ConversationLinkJob(() => db, (ids) => runs.push(ids.sort()));
    archive.ingestMessages([say('c', 0, 'hi'), say('d', 1, 'hello')], ARRIVAL.sync);
    await job.run();
    await job.run();
    expect(runs).toEqual([['c', 'd'], []]);
  });

  it('scores hidden replies against what they answered, the previous-message baseline and conversation sizes', async () => {
    const db = tempDb();
    const archive = seedArchive(db, [{ id: 'c' }]);
    const messages = pairs(20);
    archive.ingestMessages(messages, ARRIVAL.gateway);
    await new ConversationLinkJob(() => db).run();
    const answers = messages.filter((m) => m.message_reference);
    const held = answers.filter((m) => isHeldOut(m.id)).length;
    expect(held).toBeGreaterThan(0);
    const score = await scoreReplyHoldout(db);
    expect(score).toMatchObject({ replies: held, previousExact: held, messages: 40, queuedChannels: 0, fit: { samples: answers.length - held } });
    expect(score.levels[0]).toMatchObject({ minConfidence: 0, exact: held, sameConversation: held, conversations: { count: 20, median: 2, max: 2, inRunaway: 0 } });
    expect(score.stored).toEqual({ [LINK_KIND.start]: 20, [LINK_KIND.reply]: 20 });
  });
});
