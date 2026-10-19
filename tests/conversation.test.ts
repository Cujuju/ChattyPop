// The Conversation view reads a message's conversation from stored links.
import { beforeEach, describe, expect, it } from 'vitest';
import { snowflakeFromMs, snowflakeToMs, type RawMessage } from '@shared/discord';
import { MS_PER_HOUR, MS_PER_MIN } from '@shared/units';
import { setSetting, type Db } from '../src/core/db';
import { CONVERSATION_MAX, UNLINKED_MAX, conversation } from '../src/core/queries/conversation';
import { ConversationLinkJob } from '../src/core/conversations/job';
import { LINK_KIND } from '../src/core/conversations/linker';
import { channelReach, writeLinks } from '../src/core/conversations/store';
import { SETTINGS_KEYS } from '@shared/settings';
import { ARRIVAL } from '../src/core/arrival';
import { rawMessage, seedArchive, tempDb } from './helpers';

/** User ids are snowflakes: <@id> mentions only match digits. */
const user = (n: number, name: string) => ({ id: `1000000000000000${n}`, username: name, global_name: name });
const [ALICE, BOB, CAROL] = [user(11, 'alice'), user(12, 'bob'), user(13, 'carol')];
/** Discord's message type for a reply. */
const REPLY = 19;
const T0 = new Date(2026, 8, 1, 10).getTime();
const at = (minutes: number): number => T0 + minutes * MS_PER_MIN;
const id = (minutes: number): string => snowflakeFromMs(at(minutes));
const reply = (to: number): Partial<RawMessage> => ({ type: REPLY, message_reference: { message_id: id(to) } } as Partial<RawMessage>);
const LATER = MS_PER_HOUR / MS_PER_MIN;

describe('conversation view', () => {
  let db: Db;
  const texts = (minutes: number): string[] => conversation(db, id(minutes)).messages.map((m) => m.content);

  beforeEach(async () => {
    db = tempDb();
    const archive = seedArchive(db, [{ id: 'c1' }]);
    archive.ingestMessages([
      rawMessage('c1', at(0), 'any tips for proxy settings?', { author: ALICE }),
      rawMessage('c1', at(1), 'check the network panel', { author: BOB, ...reply(0) }),
      rawMessage('c1', at(2), `thanks <@${BOB.id}>`, { author: ALICE }),
      rawMessage('c1', at(3), 'follow-up: restart after', { author: BOB, ...reply(1) }),
      rawMessage('c1', at(LATER), 'lunch?', { author: CAROL }),
    ], ARRIVAL.sync);
    await new ConversationLinkJob(() => db).run();
  });

  it('shows the linked conversation, marking the messages Discord replies joined', () => {
    expect(texts(2)).toEqual(['any tips for proxy settings?', 'check the network panel', `thanks <@${BOB.id}>`, 'follow-up: restart after']);
    expect(conversation(db, id(2))).toMatchObject({ pending: false });
    expect(conversation(db, id(2)).linkedIds.sort()).toEqual([id(1), id(2), id(3)].sort());
  });

  it('keeps a message that starts its own conversation apart', () => {
    expect(texts(LATER)).toEqual(['lunch?']);
  });

  it('shows the message alone, marked pending, before its channel is linked', () => {
    db.exec('DELETE FROM conversation_links');
    db.prepare('INSERT INTO conversation_link_queue (channel_id, from_ts, until_ts) VALUES (?, ?, ?)').run('c1', at(0), at(LATER));
    expect(conversation(db, id(2))).toMatchObject({ linkedIds: [id(2)], pending: true });
    expect(texts(2)).toEqual([`thanks <@${BOB.id}>`]);
  });

  it('is empty for a message not in the archive', () => {
    expect(conversation(db, 'nope')).toEqual({ messages: [], linkedIds: [], pending: false, rootId: null, members: {}, marks: {}, memberCount: 0, unlinkedMore: false });
  });

  it('leaves out hidden channels in privacy mode', () => {
    db.prepare("UPDATE channels SET hide_in_privacy = 1 WHERE id = 'c1'").run();
    setSetting(db, SETTINGS_KEYS.privacyMode, true);
    expect(texts(1)).toEqual([]);
  });
});

describe('unlinked messages in the shown conversation window', () => {
  let db: Db;
  let archive: ReturnType<typeof seedArchive>;
  const message = (minute: number) => rawMessage('c1', at(minute), `at ${minute}`);
  const ids = (view: ReturnType<typeof conversation>): string[] => view.messages.map((m) => m.id);
  const unlinkedIds = (view: ReturnType<typeof conversation>): string[] => view.messages.filter((m) => !view.members[m.id]).map((m) => m.id);
  const seed = (members: RawMessage[], others: RawMessage[]) => {
    archive.ingestMessages([...members, ...others], ARRIVAL.sync);
    writeLinks(db, 'c1', members.map((m, i) => ({
      messageId: m.id, parentId: i ? members[0]!.id : null, kind: i ? LINK_KIND.inferred : LINK_KIND.start, confidence: 1,
    })), new Map(members.map((m) => [m.id, snowflakeToMs(m.id)])));
  };

  beforeEach(() => {
    db = tempDb();
    archive = seedArchive(db, [{ id: 'c1' }, { id: 'other' }, { id: 'hidden' }]);
  });

  it('always includes in-between non-members, but nothing before the root, after the span or in another channel', () => {
    const [root, middle, last, before, later] = [message(0), message(2), message(4), message(-1), message(5)] as const;
    const other = rawMessage('other', at(3), 'other channel');
    seed([root, last], [middle, before, later, other]);
    const view = conversation(db, root.id);
    expect(ids(view)).toEqual([root.id, middle.id, last.id]);
    expect(view).toMatchObject({ memberCount: 2, rootId: root.id, linkedIds: [root.id], unlinkedMore: false });
    expect(view.members[middle.id]).toBeUndefined();
  });

  it('nearby extends only the upper bound through the channel reach, including its endpoint', () => {
    const root = message(0);
    const last = message(4);
    const until = at(4) + channelReach(db, 'c1');
    const edge = rawMessage('c1', until, 'within reach');
    const beyond = rawMessage('c1', until + 1, 'beyond reach');
    const middle = message(2);
    seed([root, last], [middle, message(-1), edge, beyond]);
    expect(unlinkedIds(conversation(db, root.id))).toEqual([middle.id]);
    expect(unlinkedIds(conversation(db, root.id, { nearby: true }))).toEqual([middle.id, edge.id]);
  });

  it('bounds in-between messages by the shown members when the conversation is capped', () => {
    const members = Array.from({ length: CONVERSATION_MAX + 4 }, (_, i) => message(i));
    const extras = [message(0.5), message(3.5), message(4.5), message(CONVERSATION_MAX - 0.5), message(CONVERSATION_MAX + 3.5)];
    seed(members, extras);
    const tail = conversation(db, members.at(-1)!.id);
    expect(Object.keys(tail.members)).toHaveLength(CONVERSATION_MAX);
    expect(tail.memberCount).toBe(members.length);
    expect(tail.members[members[0]!.id]).toBeUndefined();
    expect(unlinkedIds(tail)).toEqual([extras[2]!.id, extras[3]!.id]);
    const head = conversation(db, members[0]!.id);
    expect(unlinkedIds(head)).toEqual(extras.slice(0, 3).map((m) => m.id));
    expect(unlinkedIds(conversation(db, members.at(-1)!.id, { nearby: true }))).toEqual(extras.slice(2).map((m) => m.id));
  });

  it('uses one nearest-first cap for in-between and later non-members and reports overflow', () => {
    const root = message(0);
    const last = message(4);
    const extras = Array.from({ length: UNLINKED_MAX + 2 }, (_, i) => rawMessage('c1', at(4) - i - 1, `extra ${i}`));
    seed([root, last], extras.slice(0, UNLINKED_MAX));
    expect(conversation(db, last.id).unlinkedMore).toBe(false);
    archive.ingestMessages(extras.slice(UNLINKED_MAX), ARRIVAL.sync);
    const view = conversation(db, last.id);
    expect(unlinkedIds(view)).toEqual(extras.slice(0, UNLINKED_MAX).reverse().map((m) => m.id));
    expect(view.unlinkedMore).toBe(true);
    const later = rawMessage('c1', at(4) + 1, 'later');
    archive.ingestMessages([later], ARRIVAL.sync);
    const extended = conversation(db, last.id, { nearby: true });
    expect(unlinkedIds(extended)).toHaveLength(UNLINKED_MAX);
    expect(unlinkedIds(extended)).toContain(later.id);
    expect(unlinkedIds(extended)).not.toContain(extras[UNLINKED_MAX - 1]!.id);
    expect(extended.unlinkedMore).toBe(true);
  });

  it('orders same-millisecond boundaries by numeric id, including different id lengths', () => {
    const atOnce = (id: string) => ({ ...message(0), id });
    seed([atOnce('9'), atOnce('11')], [atOnce('8'), atOnce('10'), atOnce('12')]);
    expect(ids(conversation(db, '9'))).toEqual(['9', '10', '11']);
    expect(ids(conversation(db, '9', { nearby: true }))).toEqual(['9', '10', '11', '12']);
  });

  it('applies privacy to in-between and later non-members', () => {
    const root = message(0);
    const last = message(4);
    const hidden = { ...message(2), content: '<#hidden>' };
    const hiddenLater = { ...message(5), content: '<#hidden>' };
    seed([root, last], [message(1), hidden, hiddenLater]);
    db.prepare("UPDATE channels SET hide_in_privacy = 1 WHERE id = 'hidden'").run();
    setSetting(db, SETTINGS_KEYS.privacyMode, true);
    expect(ids(conversation(db, root.id, { nearby: true }))).toEqual([root.id, id(1), last.id]);
  });
});
