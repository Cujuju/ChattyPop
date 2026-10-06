import { EventEmitter } from 'node:events';
import { expect, it } from 'vitest';
import type { AppEvent } from '@shared/contract';
import { phoneAppEvent } from '@shared/phone';
import { archiveHandlers } from '../src/core/archiveHandlers';
import { ReadStates } from '../src/main/discord/readStates';
import type { GatewayDispatch, GatewayTap } from '../src/main/discord/gatewayTap';
import { rawMessage, seedArchive, tempDb } from './helpers';

const ME = '900000000000000001';
const GUILD = '100000000000000001';
const OPEN = '200000000000000001';
const OTHER = '200000000000000002';
const NOW = Date.UTC(2026, 9, 6);

it('projects live arrivals and external reads of an inactive channel to desktop and phone counts', () => {
  const db = tempDb();
  const archive = seedArchive(db, [{ id: OPEN }, { id: OTHER }], { guilds: [{ id: GUILD, name: 'Guild' }] });
  const events: AppEvent[] = [];
  const changes: string[] = [];
  const handlers = archiveHandlers({
    ready: () => ({ db, archive }),
    emit: (e) => events.push(e),
    noteChanged: (id) => changes.push(id),
    backfillFromMs: () => 0,
    selfId: () => ME,
    lastSeenAt: () => NOW - 1,
    applyTextTier: async () => {},
    autoArchiveSinceMs: () => null,
  });
  const tap = new EventEmitter<{ dispatch: [GatewayDispatch] }>();
  new ReadStates(tap as unknown as GatewayTap, { post: async () => { throw new Error('No Discord writes expected'); } }, handlers.putReadStates, () => {});
  tap.on('dispatch', ({ t, d }) => {
    if (t === 'MESSAGE_CREATE') handlers.applyGatewayEvent(t, d);
  });
  const send = (t: string, d: unknown): void => void tap.emit('dispatch', { t, d, s: null });
  const row = (id: string) => handlers.directory().flatMap((g) => g.channels).find((c) => c.id === id)!;
  const mark = rawMessage(OPEN, NOW, 'seen', { guild_id: GUILD });
  send('READY', { user: { id: ME }, read_state: { entries: [], partial: false } });
  send('MESSAGE_CREATE', mark);
  handlers.markChannelRead(OPEN, mark.id);
  events.length = 0;
  changes.length = 0;

  const first = rawMessage(OTHER, NOW + 1, 'ordinary', { guild_id: GUILD });
  const ping = rawMessage(OTHER, NOW + 2, 'ping', { guild_id: GUILD, mentions: [{ id: ME, username: 'owner' }] });
  send('MESSAGE_CREATE', first);
  send('MESSAGE_CREATE', ping);
  send('MESSAGE_CREATE', ping);
  expect(row(OPEN).newCount).toBe(0);
  expect(row(OTHER)).toMatchObject({ messageCount: 2, newCount: 2, mentionCount: 1 });
  expect(changes).toEqual([OTHER, OTHER]);
  expect(events.map(phoneAppEvent)).toEqual(events);

  send('MESSAGE_ACK', { channel_id: OTHER, message_id: first.id });
  expect(row(OTHER)).toMatchObject({ newCount: 1, mentionCount: 1 });
  expect(handlers.channelUnread(OTHER)?.firstId).toBe(ping.id);
  expect(events.at(-1)).toMatchObject({ type: 'read-states-changed', states: [{ channelId: OTHER, ackId: first.id, mentionCount: 1 }] });

  send('MESSAGE_ACK', { channel_id: OTHER, message_id: ping.id, mention_count: 0 });
  expect(row(OTHER)).toMatchObject({ newCount: 0, mentionCount: 0 });
  expect(handlers.channelUnread(OTHER)).toBeNull();
  const own = rawMessage(OTHER, NOW + 3, 'mine', { guild_id: GUILD, author: { id: ME, username: 'owner' } });
  send('MESSAGE_CREATE', own);
  expect(row(OTHER)).toMatchObject({ messageCount: 3, newCount: 0, mentionCount: 0 });
  db.close();
});
