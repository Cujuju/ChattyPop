// The Conversation view reads a message's conversation from stored links.
import { beforeEach, describe, expect, it } from 'vitest';
import { snowflakeFromMs, type RawMessage } from '@shared/discord';
import { MS_PER_HOUR, MS_PER_MIN } from '@shared/units';
import { setSetting, type Db } from '../src/core/db';
import { conversation } from '../src/core/queries/conversation';
import { ConversationLinkJob } from '../src/core/conversations/job';
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
    expect(conversation(db, 'nope')).toEqual({ messages: [], linkedIds: [], pending: false });
  });

  it('leaves out hidden channels in privacy mode', () => {
    db.prepare("UPDATE channels SET hide_in_privacy = 1 WHERE id = 'c1'").run();
    setSetting(db, SETTINGS_KEYS.privacyMode, true);
    expect(texts(1)).toEqual([]);
  });
});
