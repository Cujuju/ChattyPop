// The owner's marks on conversation links: the linker's precedence, what marking stores and relinks, and the view's members and nearby messages.
import { beforeEach, describe, expect, it } from 'vitest';
import { MS_PER_MIN } from '@shared/units';
import type { RawMessage } from '@shared/discord';
import { ARRIVAL } from '@core/arrival';
import type { Db } from '@core/db';
import { DEFAULT_WEIGHTS } from '@core/conversations/chooser';
import { topicWords } from '@core/conversations/features';
import { ConversationLinkJob } from '@core/conversations/job';
import { JUDGE_BELOW, LINK_KIND, linkMessages, type Judge, type LinkInput } from '@core/conversations/linker';
import { markConversation } from '@core/conversations/marks';
import { conversation } from '@core/queries/conversation';
import { rawMessage, seedArchive, tempDb } from './helpers';

const T0 = Date.UTC(2026, 8, 1, 12);
const REACH = 10 * MS_PER_MIN;
const msg = (id: string, authorId: string, minute: number, text = '', extra: Partial<LinkInput> = {}): LinkInput => ({
  id, authorId, ts: T0 + minute * MS_PER_MIN, replyTo: null, mentions: [], repliesToAuthor: null,
  words: topicWords(text), question: text.includes('?'), text, ...extra,
});
/** Always picks the oldest candidate, sure of it. */
const oldest: Judge = () => ({ index: 0, probability: 0.99 });

describe('linker precedence', () => {
  const link = (before: LinkInput[], m: LinkInput, ctx: { marked?: Record<string, string | null>; judge?: Judge } = {}, hideReplies = false) =>
    linkMessages(before, [m], {
      reachMs: REACH, weights: DEFAULT_WEIGHTS, judge: ctx.judge,
      marked: (id) => (ctx.marked && id in ctx.marked ? { parentId: ctx.marked[id]! } : undefined),
    }, { hideReplies })[0]!;
  const two = [msg('p', 'ann', 0, 'any tips for proxy settings?'), msg('l', 'cy', 1, 'who wants lunch')];

  it('takes an owner mark over rules and the chooser, but not over a Discord reply or while scoring', () => {
    expect(link([msg('a', 'bob', 0)], msg('b', 'bob', 1), { marked: { b: null } })).toMatchObject({ parentId: null, kind: LINK_KIND.owner });
    expect(link(two, msg('m', 'bob', 2), { marked: { m: 'p' } })).toMatchObject({ parentId: 'p', kind: LINK_KIND.owner, confidence: 1 });
    expect(link(two, msg('m', 'bob', 2, '', { replyTo: 'l' }), { marked: { m: 'p' } })).toMatchObject({ parentId: 'l', kind: LINK_KIND.reply });
    expect(link(two, msg('m', 'bob', 2), { marked: { m: 'p' } }, true).kind).toBe(LINK_KIND.inferred);
  });

  it('lets the judge re-rank only links the chooser made below JUDGE_BELOW', () => {
    const unsure = link(two, msg('m', 'bob', 2, 'try restarting it'));
    expect(unsure.confidence).toBeLessThan(JUDGE_BELOW);
    expect(link(two, msg('m', 'bob', 2, 'try restarting it'), { judge: oldest })).toMatchObject({ parentId: 'p', kind: LINK_KIND.judged, confidence: 0.99 });
    // One candidate: the chooser is sure.
    expect(link([two[0]!], msg('m', 'bob', 2), { judge: oldest }).kind).toBe(LINK_KIND.inferred);
    const crowd = Array.from({ length: 10 }, (_, i) => msg(`c${i}`, `u${i}`, i * 0.5));
    expect(link(crowd, msg('m', 'zed', 5), { judge: oldest }).kind).toBe(LINK_KIND.start);
  });
});

const ann = { id: '100000000000000001', username: 'ann' };
const bob = { id: '100000000000000002', username: 'bob' };
const cy = { id: '100000000000000003', username: 'cy' };
const say = (channel: string, minute: number, content: string, author: typeof ann, extra: Partial<RawMessage> = {}): RawMessage =>
  rawMessage(channel, T0 + minute * MS_PER_MIN, content, { author, ...extra });

describe('marking a conversation', () => {
  let db: Db;
  let job: ConversationLinkJob;
  let archive: ReturnType<typeof seedArchive>;
  const proxy = say('c', 0, 'any tips for proxy settings?', ann);
  const lunch = say('c', 1, 'who wants lunch', cy);
  const restart = say('c', 2, 'try restarting it', bob);
  const noon = say('c', 3, 'sure, noon works', ann);
  const thanks = say('c', 4, 'ok thanks', cy);
  const answer = say('c', 5, 'the network panel has them', bob, { type: 19, message_reference: { message_id: proxy.id } } as Partial<RawMessage>);
  const elsewhere = say('other', 6, 'hello', ann);
  const linkOf = (id: string) => db.prepare('SELECT parent_id AS parentId, kind FROM conversation_links WHERE message_id = ?').get(id);
  const log = () => db.prepare('SELECT message_id AS id, mark, parent_id AS parentId, replaced_parent_id AS replaced FROM conversation_mark_log ORDER BY seq').all();
  const mark = async (id: string, m: Parameters<typeof markConversation>[3], of = restart.id) => {
    markConversation(db, id, of, m);
    await job.run();
  };

  beforeEach(async () => {
    db = tempDb();
    archive = seedArchive(db, [{ id: 'c' }, { id: 'other' }]);
    archive.ingestMessages([proxy, lunch, restart, noon, thanks, answer, elsewhere], ARRIVAL.sync);
    job = new ConversationLinkJob(() => db);
    await job.run();
  });

  it('shows members with their kind, the unsure ones, and how many continue each', () => {
    const c = conversation(db, restart.id);
    expect(c.rootId).toBe(proxy.id);
    expect(c.memberCount).toBe(6);
    expect(c.members[restart.id]).toMatchObject({ kind: LINK_KIND.inferred, questionable: true, explicit: false, branch: 1 });
    expect(c.marks).toEqual({});
    expect(c.members[answer.id]).toMatchObject({ kind: LINK_KIND.reply, questionable: false, explicit: true });
    // lunch's single candidate made its link certain.
    expect(c.members[lunch.id]).toMatchObject({ questionable: false, branch: 3 });
    expect(c.nearbyMore).toBe(false);
  });

  it('removes a message with “not”, logs it, and Undo restores the link', async () => {
    await mark(restart.id, 'not');
    expect(linkOf(restart.id)).toEqual({ parentId: null, kind: LINK_KIND.owner });
    expect(conversation(db, proxy.id).members[restart.id]).toBeUndefined();
    expect(log()).toEqual([{ id: restart.id, mark: 'not', parentId: null, replaced: lunch.id }]);
    await mark(restart.id, null, proxy.id);
    expect(linkOf(restart.id)).toEqual({ parentId: lunch.id, kind: LINK_KIND.inferred });
    expect(db.prepare('SELECT COUNT(*) FROM conversation_marks').pluck().get()).toBe(0);
    expect(log()).toHaveLength(2);
  });

  it('keeps a confirmed link as the owner’s and stops calling it unsure', async () => {
    await mark(noon.id, 'belongs');
    expect(linkOf(noon.id)).toEqual({ parentId: lunch.id, kind: LINK_KIND.owner });
    expect(conversation(db, restart.id)).toMatchObject({ members: { [noon.id]: { questionable: false } }, marks: { [noon.id]: 'belongs' } });
  });

  it('lists nearby non-members on request and adds one to the member it most likely continues', async () => {
    await mark(thanks.id, 'not');
    expect(conversation(db, restart.id).messages.map((m) => m.id)).not.toContain(thanks.id);
    const near = conversation(db, restart.id, { nearby: true });
    expect(near.messages.map((m) => m.id)).toContain(thanks.id);
    expect(near.messages.map((m) => m.id)).not.toContain(elsewhere.id);
    expect(near.members[thanks.id]).toBeUndefined();
    // Its mark comes with it, so Undo survives reopening the window.
    expect(near.marks[thanks.id]).toBe('not');
    await mark(thanks.id, 'add');
    const added = linkOf(thanks.id) as { parentId: string; kind: string };
    expect(added.kind).toBe(LINK_KIND.owner);
    expect(conversation(db, restart.id)).toMatchObject({ members: { [thanks.id]: { kind: LINK_KIND.owner } }, marks: { [thanks.id]: 'add' } });
  });

  it('lists a nearby message sent in the root’s millisecond after it', async () => {
    const twin = { ...say('c', 0, 'also the dns settings', cy), id: (BigInt(proxy.id) + 1n).toString() };
    archive.ingestMessages([twin], ARRIVAL.sync);
    await job.run();
    await mark(twin.id, 'not', proxy.id);
    expect(conversation(db, restart.id, { nearby: true }).messages.map((m) => m.id)).toContain(twin.id);
  });

  it('refuses marks that don’t fit the conversation', () => {
    expect(() => markConversation(db, answer.id, restart.id, 'not')).toThrow(/Discord linked/);
    expect(() => markConversation(db, proxy.id, restart.id, 'not')).toThrow(/starts this conversation/);
    expect(() => markConversation(db, noon.id, restart.id, 'add')).toThrow(/already in this conversation/);
    expect(() => markConversation(db, elsewhere.id, restart.id, 'add')).toThrow(/later message of the same channel/);
    expect(() => markConversation(db, elsewhere.id, restart.id, 'belongs')).toThrow(/isn’t in this conversation/);
    expect(() => markConversation(db, 'nope', restart.id, 'not')).toThrow(/isn’t in the archive/);
    expect(log()).toEqual([]);
  });
});
