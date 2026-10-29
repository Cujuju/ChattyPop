import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { OwnerSession } from '../src/main/discord/ownerSession';
import { SavedAccess } from '../src/main/discord/savedAccess';
import type { SavedChannelAccess } from '@shared/savedMessages';

describe('native saved-message access', () => {
  it('intersects core permission facts with current guilds, parents and private-thread membership', async () => {
    const tap = new EventEmitter(), owner = '900000000000000001', other = '900000000000000002';
    let channels = [{ id: 'parent' }];
    const rules: SavedChannelAccess[] = [
      { channelId: 'parent', guildId: 'guild', parentId: null, privateThread: false },
      { channelId: 'public', guildId: 'guild', parentId: 'parent', privateThread: false },
      { channelId: 'private', guildId: 'guild', parentId: 'parent', privateThread: true },
      { channelId: 'departed', guildId: 'guild', parentId: null, privateThread: false },
      { channelId: 'dm', guildId: null, parentId: null, privateThread: false },
    ];
    const capture = { current: {}, sessionGeneration: 1, gatewayAuthorized: true, expectGatewayAuthorization: () => undefined, matchesGatewayAuthorization: () => true };
    const access = new SavedAccess(tap as never, new OwnerSession(tap as never, capture as never), { channelsOf: () => channels as never }, { call: async (_method: string, account: string) => account === owner ? rules : [] } as never);
    tap.emit('sent', { op: 2, socketId: 'socket', d: {} });
    const dispatch = (t: string, d: unknown, socketId = 'socket') => tap.emit('dispatch', { t, d, socketId });
    dispatch('READY', { user: { id: owner }, guilds: [{ id: 'guild', threads: [{ id: 'private', parent_id: 'parent' }] }] });
    expect(await access.channels(owner)).toEqual(['parent', 'public', 'private', 'dm']);
    dispatch('THREAD_LIST_SYNC', { guild_id: 'different', threads: [] });
    expect(await access.channels(owner)).toContain('private');
    dispatch('THREAD_MEMBERS_UPDATE', { id: 'private', removed_member_ids: [owner] });
    dispatch('THREAD_UPDATE', { id: 'private', guild_id: 'guild', parent_id: 'parent' });
    expect(await access.channels(owner)).not.toContain('private');
    dispatch('THREAD_MEMBERS_UPDATE', { id: 'private', added_members: [{ user_id: owner }] });
    expect(await access.channels(owner)).toContain('private');
    dispatch('READY', { user: { id: other }, guilds: [] }, 'old-socket');
    expect(await access.channels(owner)).toContain('private');
    dispatch('THREAD_LIST_SYNC', { guild_id: 'guild', threads: [{ id: 'private', parent_id: 'parent' }] });
    expect(await access.channels(owner)).toContain('private');
    dispatch('THREAD_LIST_SYNC', { guild_id: 'guild', threads: [] });
    expect(await access.channels(owner)).not.toContain('private');
    channels = []; expect(await access.channels(owner)).toEqual(['dm']); expect(await access.channels(other)).toEqual([]);
  });
});
