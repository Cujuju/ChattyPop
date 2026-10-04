import { beforeEach, describe, expect, it } from 'vitest';
import { snowflakeFromMs, type RawMessage } from '@shared/discord';
import { setSetting, type Db } from '../src/core/db';
import { CONVERSATION_GAP_MS, conversation } from '../src/core/queries/conversation';
import { SETTINGS_KEYS } from '@shared/settings';
import { ARRIVAL } from '../src/core/arrival';
import { rawMessage, seedArchive, tempDb } from './helpers';

/** User ids are snowflakes: <@id> mentions only match digits. */
const user = (n: number, name: string) => ({ id: `1000000000000000${n}`, username: name, global_name: name });
const [ALICE, BOB, CAROL, DAVE] = [user(11, 'alice'), user(12, 'bob'), user(13, 'carol'), user(14, 'dave')];
/** Discord's message type for a reply. */
const REPLY = 19;
const MIN = 60_000;
const T0 = new Date(2026, 8, 1, 10).getTime();
const at = (minutes: number): number => T0 + minutes * MIN;
const reply = (to: number): Partial<RawMessage> => ({ type: REPLY, message_reference: { message_id: snowflakeFromMs(to) } } as Partial<RawMessage>);

describe('conversation view', () => {
  let db: Db;
  const view = (ms: number) => conversation(db, snowflakeFromMs(ms));
  const texts = (ms: number): string[] => view(ms).messages.map((m) => m.content);

  beforeEach(() => {
    db = tempDb();
    const archive = seedArchive(db, [{ id: 'c1' }]);
    archive.ingestMessages([
      rawMessage('c1', at(-2), `hey <@${ALICE.id}>`, { author: DAVE }),
      rawMessage('c1', at(0), 'question', { author: ALICE }),
      rawMessage('c1', at(1), 'answer', { author: BOB, ...reply(at(0)) }),
      rawMessage('c1', at(2), 'lunch?', { author: CAROL }),
      rawMessage('c1', at(3), `thanks <@${BOB.id}>`, { author: ALICE }),
      rawMessage('c1', at(4), 'follow-up', { author: BOB, ...reply(at(1)) }),
      rawMessage('c1', at(4) + CONVERSATION_GAP_MS + MIN, 'much later', { author: ALICE }),
    ], ARRIVAL.sync);
  });

  it('follows the reply chain up to its root and down through every reply', () => {
    expect(view(at(4)).linkedIds.sort()).toEqual([at(0), at(1), at(4)].map((ms) => snowflakeFromMs(ms)).sort());
  });

  it('adds nearby messages by participants or mentioning them, and stops at a long pause', () => {
    expect(texts(at(1))).toEqual([`hey <@${ALICE.id}>`, 'question', 'answer', `thanks <@${BOB.id}>`, 'follow-up']);
  });

  it('is empty for a message not in the archive', () => {
    expect(conversation(db, 'nope')).toEqual({ messages: [], linkedIds: [] });
  });

  it('leaves out hidden channels in privacy mode', () => {
    db.prepare("UPDATE channels SET hide_in_privacy = 1 WHERE id = 'c1'").run();
    setSetting(db, SETTINGS_KEYS.privacyMode, true);
    expect(view(at(1)).messages).toEqual([]);
  });
});
