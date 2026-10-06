// READY private-channel lists belong to one account. Recipients resolve from objects or READY user IDs; lists support bare, versioned, and partial forms.
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { GatewayDispatch, GatewayTap } from '../src/main/discord/gatewayTap';
import { privateChannelsShape, readyPrivateChannels, watchPrivateChannels } from '../src/main/discord/privateChannels';

const ME = '900000000000000001';
const BOB = { id: '110000000000000001', username: 'bob', global_name: 'Bob' };
const CY = { id: '110000000000000002', username: 'cy' };
const DM = '400000000000000001';
const GROUP = '400000000000000002';

/** A watched tap, the core calls READY makes (in order), and the shape notes. */
function watch() {
  const tap = new EventEmitter<{ dispatch: [GatewayDispatch] }>();
  const calls: unknown[][] = [];
  const notes: Record<string, unknown>[] = [];
  watchPrivateChannels(tap as unknown as GatewayTap, { call: async (...args: unknown[]) => void calls.push(args) } as never, (_e, data) => void notes.push(data));
  return { tap, calls, notes };
}

describe("READY's private channels", () => {
  it("each READY names core's signed-in account before its DM list, so a token switch without a 401 still moves it", () => {
    const { tap, calls } = watch();
    const OTHER = { id: '900000000000000002', username: 'alt' };
    tap.emit('dispatch', { t: 'READY', s: 1, d: { user: { id: ME, username: 'me' }, private_channels: [] } });
    tap.emit('dispatch', { t: 'READY', s: 1, d: { user: OTHER, private_channels: [] } });
    expect(calls).toEqual([
      ['setSelf', { id: ME, username: 'me' }],
      ['replacePrivateChannels', ME, [], false],
      ['setSelf', OTHER],
      ['replacePrivateChannels', OTHER.id, [], false],
    ]);
  });

  it('resolves recipient_ids through READY users, and takes full recipients as sent', () => {
    const list = readyPrivateChannels({
      user: { id: ME },
      users: [BOB, CY],
      private_channels: [
        { id: DM, type: 1, recipient_ids: [BOB.id], last_message_id: '500000000000000001', flags: 0 },
        { id: GROUP, type: 3, name: null, owner_id: CY.id, recipients: [CY], is_message_request: false },
      ],
    });
    expect(list).toEqual({
      self: { id: ME },
      partial: false,
      channels: [
        { id: DM, type: 1, recipients: [BOB], last_message_id: '500000000000000001' },
        { id: GROUP, type: 3, name: null, owner_id: CY.id, recipients: [CY], is_message_request: false },
      ],
    });
  });

  it('an id READY users do not name leaves the roster unknown rather than short', () => {
    const list = readyPrivateChannels({ user: { id: ME }, users: [BOB], private_channels: [{ id: GROUP, type: 3, recipient_ids: [BOB.id, CY.id] }] });
    expect(list?.channels[0]).toEqual({ id: GROUP, type: 3 });
  });

  it('reads a versioned list and passes on that it is partial', () => {
    const list = readyPrivateChannels({ user: { id: ME }, users: [BOB], private_channels: { entries: [{ id: DM, type: 1, recipient_ids: [BOB.id] }], partial: true, version: 3 } });
    expect(list).toMatchObject({ partial: true, channels: [{ id: DM, recipients: [BOB] }] });
  });

  it('a READY that leaves its private_channels out is partial: it closes nothing', () => {
    expect(readyPrivateChannels({ user: { id: ME } })).toMatchObject({ channels: [], partial: true });
  });

  it('READY without a user is no list', () => {
    expect(readyPrivateChannels({ private_channels: [] })).toBeNull();
  });

  it('notes the shape once per READY (field names and counts only) and hands core the list', () => {
    const { tap, calls, notes } = watch();
    const d = {
      user: { id: ME },
      users: [BOB],
      private_channels: [
        { id: DM, type: 1, recipient_ids: [BOB.id], is_message_request: false, is_spam: false },
        { id: GROUP, type: 3, name: 'secret plans', recipient_ids: [CY.id] },
      ],
    };
    tap.emit('dispatch', { t: 'MESSAGE_CREATE', s: 1, d: {} });
    tap.emit('dispatch', { t: 'READY', s: 1, d });
    expect(calls.filter(([m]) => m === 'replacePrivateChannels').map(([, , channels]) => (channels as unknown[]).length)).toEqual([2]);
    expect(notes).toEqual([privateChannelsShape(d)]);
    expect(notes[0]).toMatchObject({ list: 'array', channels: 2, withRecipientIds: 2, unresolvedRecipients: 1, isMessageRequest: 1, isSpam: 1 });
    const note = JSON.stringify(notes[0]);
    for (const secret of [DM, GROUP, BOB.id, CY.id, 'Bob', 'secret plans']) expect(note).not.toContain(secret);
  });
});
