// Conversation links: the rules on their own, then the background job over a real archive.
import { describe, expect, it } from 'vitest';
import { MS_PER_HOUR, MS_PER_MIN } from '@shared/units';
import { ARRIVAL } from '@core/arrival';
import { getSetting, type Db } from '@core/db';
import { linkMessages, LINK_KIND, type LinkInput } from '@core/conversations/linker';
import { ConversationLinkJob, LINKER_VERSION, LINKER_VERSION_KEY } from '@core/conversations/job';
import { channelGap, PACE_FALLBACK_MS, PACE_MIN_REPLIES } from '@core/conversations/store';
import { scoreReplyHoldout } from '@core/conversations/score';
import { PUBLIC_THREAD_TYPE, type RawMessage } from '@shared/discord';
import { rawMessage, seedArchive, tempDb } from './helpers';

const T0 = Date.UTC(2026, 8, 1, 12);
const GAP = 10 * MS_PER_MIN;
const msg = (id: string, authorId: string, minute: number, extra: Partial<LinkInput> = {}): LinkInput =>
  ({ id, authorId, ts: T0 + minute * MS_PER_MIN, replyTo: null, mentions: [], ...extra });
const kinds = (before: LinkInput[], messages: LinkInput[], options = {}) =>
  linkMessages(before, messages, { gapMs: GAP }, options).map((l) => [l.messageId, l.parentId, l.kind]);

describe('linker rules', () => {
  it('prefers a reply, then a mention, then the author continuing, then a back-and-forth, then adjacency', () => {
    const a1 = msg('a1', 'ann', 0);
    const b1 = msg('b1', 'bob', 1);
    expect(kinds([], [a1, b1,
      msg('a2', 'ann', 2),
      msg('a3', 'ann', 3),
      msg('c1', 'cy', 4),
      msg('d1', 'dee', 5, { mentions: ['bob'] }),
      msg('e1', 'eve', 6, { replyTo: 'a1', mentions: ['bob'] }),
    ])).toEqual([
      ['a1', null, LINK_KIND.start],
      ['b1', 'a1', LINK_KIND.adjacent],
      ['a2', 'b1', LINK_KIND.exchange],
      ['a3', 'a2', LINK_KIND.continuation],
      ['c1', 'a3', LINK_KIND.adjacent],
      ['d1', 'b1', LINK_KIND.mention],
      ['e1', 'a1', LINK_KIND.reply],
    ]);
  });

  it("answers across the other person's run of messages as a back-and-forth", () => {
    expect(kinds([msg('a1', 'ann', 0), msg('b1', 'bob', 1), msg('b2', 'bob', 2)], [msg('a2', 'ann', 3)]))
      .toEqual([['a2', 'b2', LINK_KIND.exchange]]);
  });

  it('starts a conversation after the gap, and a mention only reaches people who spoke within it', () => {
    expect(kinds([msg('b1', 'bob', 0)], [msg('a1', 'ann', 11, { mentions: ['bob'] }), msg('a2', 'ann', 30)]))
      .toEqual([['a1', null, LINK_KIND.start], ['a2', null, LINK_KIND.start]]);
  });

  it('links a thread’s first message to its starter, and hides replies when scoring', () => {
    const links = linkMessages([], [msg('t1', 'ann', 0), msg('t2', 'bob', 1, { replyTo: 't1' })],
      { gapMs: GAP, thread: { firstId: 't1', starterId: 'starter' } }, { hideReplies: true });
    expect(links.map((l) => [l.parentId, l.kind])).toEqual([['starter', LINK_KIND.thread], ['t1', LINK_KIND.adjacent]]);
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

describe('conversation link job', () => {
  it('links what ingest queues, relinks when older history arrives, and empties the queue', async () => {
    const db = tempDb();
    const archive = seedArchive(db, [{ id: 'c' }]);
    const job = new ConversationLinkJob(() => db);
    const q = say('c', 0, 'question');
    const a = say('c', 2, 'answer', bob, replyTo(q));
    const late = say('c', 3, 'later');
    archive.ingestMessages([q, a, late], ARRIVAL.gateway);
    await job.run();
    expect(linksOf(db).get(late.id)).toEqual([a.id, LINK_KIND.exchange]);
    expect(linksOf(db).get(a.id)).toEqual([q.id, LINK_KIND.reply]);
    // A history page delivers a message between them: the message after it is relinked.
    const between = say('c', 2.5, 'between', cy);
    archive.ingestMessages([between], ARRIVAL.sync);
    await job.run();
    expect(linksOf(db).get(late.id)).toEqual([between.id, LINK_KIND.adjacent]);
    expect(db.prepare('SELECT COUNT(*) FROM conversation_link_queue').pluck().get()).toBe(0);
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
    expect(linksOf(db).get(a.id)).toEqual([c.id, LINK_KIND.adjacent]);
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

  it("measures a channel's gap from its own reply delays, else the archive's, else the fallback", async () => {
    const db = tempDb();
    const archive = seedArchive(db, [{ id: 'slow' }, { id: 'quiet' }]);
    const job = new ConversationLinkJob(() => db);
    expect(channelGap(db, 'slow')).toBe(PACE_FALLBACK_MS);
    const messages: RawMessage[] = [];
    for (let i = 0; i < PACE_MIN_REPLIES; i++) {
      const asked = say('slow', i * 300, `question ${i}`);
      messages.push(asked, say('slow', i * 300 + 60, `answer ${i}`, bob, replyTo(asked)));
    }
    archive.ingestMessages(messages, ARRIVAL.sync);
    await job.run();
    expect(channelGap(db, 'slow')).toBe(MS_PER_HOUR);
    expect(channelGap(db, 'quiet')).toBe(MS_PER_HOUR);
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

  it('scores hidden replies against what they answered, the conversation and the previous-message baseline', async () => {
    const db = tempDb();
    const archive = seedArchive(db, [{ id: 'c' }]);
    const q = say('c', 0, 'question');
    const a = say('c', 1, 'answer', bob, replyTo(q));
    const aside = say('c', 2, 'aside', cy);
    const follow = say('c', 3, 'follow-up', ann, replyTo(a));
    archive.ingestMessages([q, a, aside, follow], ARRIVAL.gateway);
    await new ConversationLinkJob(() => db).run();
    const score = await scoreReplyHoldout(db);
    expect(score).toMatchObject({ replies: 2, exact: 1, sameConversation: 2, previousExact: 1, queuedChannels: 0 });
    expect(score.byKind[LINK_KIND.adjacent]).toEqual({ replies: 2, exact: 1, sameConversation: 2 });
    expect(score.stored).toEqual({ [LINK_KIND.start]: 1, [LINK_KIND.reply]: 2, [LINK_KIND.adjacent]: 1 });
  });
});
