// Contract (docs/dms.md §3.4): an event patches the renderer's directory in place. A directory read already in flight
// may answer with data older than the patch; the patch then applies to that answer again, so it is never reverted.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { AppEvent, DirectoryChannel, DirectoryGuild } from '@shared/contract';
import { DM_CHANNEL_TYPE, DM_GUILD_ID } from '@shared/discord';
import { SETTINGS_KEYS } from '@shared/settings';

// The client runtime, so resources load as in a window (node resolves solid-js to its server build).
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);

const env = vi.hoisted(() => ({
  reads: [] as ((guilds: DirectoryGuild[]) => void)[],
  listeners: new Map<string, (e: unknown) => void>(),
}));
vi.mock('@/api', () => ({ api: { core: { directory: () => new Promise<DirectoryGuild[]>((resolve) => env.reads.push(resolve)) } } }));
vi.mock('../src/renderer/src/state/events', () => ({ onAppEvent: (type: string, fn: (e: unknown) => void) => void env.listeners.set(type, fn) }));

// A renderer module: imported by path so the node type-check doesn't follow it.
const statePath = '../src/renderer/src/state/directory';
const { directory } = (await import(statePath)) as { directory(): DirectoryGuild[] };

const DM = '400000000000000001';
const OTHER = '400000000000000002';
const send = (e: AppEvent): void => env.listeners.get(e.type)!(e);
const settle = (): Promise<void> => new Promise((r) => setTimeout(r));

function dmRow(id: string, lastMessageId: string): DirectoryChannel {
  return {
    id,
    guildId: DM_GUILD_ID,
    name: id,
    kind: DM_CHANNEL_TYPE,
    parentId: null,
    optedIn: false,
    messageCount: 0,
    newCount: 0,
    notableCount: 0,
    mentionCount: 0,
    lastTs: null,
    localAiOnly: false,
    textTier: null,
    hideInPrivacy: false,
    icon: null,
    peer: null,
    dm: { recipients: [], rosterKnown: true, ownerId: null, lastMessageId, ackId: null, muteEndsMs: null, closed: false, request: false, archived: 'never', preview: null },
  };
}
const guilds = (...channels: DirectoryChannel[]): DirectoryGuild[] => [{ id: DM_GUILD_ID, name: 'Direct messages', icon: null, hideInPrivacy: false, channels }];
const order = (): [string, string | null][] => directory()[0]!.channels.map((c) => [c.id, c.dm?.lastMessageId ?? null]);

describe("the renderer's directory", () => {
  it('a DM message that lands while a read is in flight survives that read’s older answer', async () => {
    env.reads.shift()!(guilds(dmRow(OTHER, '500000000000000002'), dmRow(DM, '500000000000000001')));
    await settle();
    send({ type: 'archive-changed', channelIds: [''] });
    send({ type: 'dm-activity', channelId: DM, lastMessageId: '500000000000000003' });
    expect(order()).toEqual([[DM, '500000000000000003'], [OTHER, '500000000000000002']]);
    // The read began before that message: its answer still has the older id.
    env.reads.shift()!(guilds(dmRow(OTHER, '500000000000000002'), dmRow(DM, '500000000000000001')));
    await settle();
    expect(order()).toEqual([[DM, '500000000000000003'], [OTHER, '500000000000000002']]);
    // A later read that already holds a newer id keeps it: activity only rises.
    send({ type: 'archive-changed', channelIds: [''] });
    send({ type: 'dm-activity', channelId: DM, lastMessageId: '500000000000000004' });
    env.reads.shift()!(guilds(dmRow(DM, '500000000000000005'), dmRow(OTHER, '500000000000000002')));
    await settle();
    expect(order()[0]).toEqual([DM, '500000000000000005']);
  });

  it("a read state change patches its row's count, last read and mute; a field it leaves out stays", async () => {
    send({ type: 'archive-changed', channelIds: [''] });
    send({ type: 'read-states-changed', states: [{ channelId: DM, mentionCount: 2, ackId: '500000000000000004' }] });
    env.reads.shift()!(guilds(dmRow(DM, '500000000000000005')));
    await settle();
    const row = directory()[0]!.channels[0]!;
    expect([row.mentionCount, row.dm?.ackId, row.dm?.muteEndsMs]).toEqual([2, '500000000000000004', null]);
    send({ type: 'read-states-changed', states: [{ channelId: DM, muteEndsMs: 9 }] });
    const after = directory()[0]!.channels[0]!;
    expect([after.mentionCount, after.dm?.ackId, after.dm?.muteEndsMs]).toEqual([2, '500000000000000004', 9]);
  });

  it('refreshes new and notable counts on bot policy changes, but ignores unrelated preferences', async () => {
    const pending = env.reads.length;
    send({ type: 'setting-changed', key: SETTINGS_KEYS.appearance, value: {} });
    expect(env.reads).toHaveLength(pending);
    send({ type: 'setting-changed', key: SETTINGS_KEYS.countedBots, value: ['bot'] });
    expect(env.reads).toHaveLength(pending + 1);
    const changed = { ...dmRow(DM, '500000000000000001'), newCount: 2, notableCount: 1 };
    for (const resolve of env.reads.splice(0)) resolve(guilds(changed));
    await settle();
    expect(directory()[0]!.channels[0]).toMatchObject({ newCount: 2, notableCount: 1 });
  });
});
