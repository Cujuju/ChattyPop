// The server list and channels come from the client's gateway, as user accounts receive them; the directory and the probe send nothing.
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { GatewayDispatch } from '../src/main/discord/gatewayTap';

vi.mock('electron', () => ({ app: { getPath: () => '' } }));

const { GatewayDirectory } = await import('../src/main/discord/directory');
const { SyncService } = await import('../src/main/sync/syncService');
const { probeDiscord } = await import('../src/main/discord/probe');

const G1 = '1000000000000000001';
const G2 = '1000000000000000002';
const TEXT = { id: '1000000000000000011', name: 'general', type: 0 };
const VOICE = { id: '1000000000000000012', name: 'talk', type: 2 };

function gateway() {
  const tap = new EventEmitter<{ dispatch: [GatewayDispatch] }>();
  const send = (t: string, d: unknown): boolean => tap.emit('dispatch', { t, s: 1, d });
  return { tap, send, directory: new GatewayDirectory(tap as never) };
}

describe('gateway directory', () => {
  it('reads servers from READY (properties nested), later from GUILD_CREATE, and keeps channels through updates', () => {
    const { send, directory } = gateway();
    expect(directory.guildList()).toEqual([]);
    send('READY', { guilds: [{ id: G1, properties: { name: 'One', icon: 'abc', features: ['NEWS'] }, channels: [TEXT, VOICE] }, { id: G2, unavailable: true }] });
    expect(directory.guildList()).toEqual([{ id: G1, name: 'One', icon: 'abc', features: ['NEWS'] }]);
    expect(directory.channelsOf(G2)).toBeNull();
    send('GUILD_CREATE', { id: G2, properties: { name: 'Two', icon: null }, channels: [] });
    expect(directory.channelsOf(G2)).toEqual([]);
    // An update without a channel list or features keeps them; a renamed server takes its new name.
    send('GUILD_UPDATE', { id: G1, name: 'Uno' });
    expect(directory.guildList()[0]).toEqual({ id: G1, name: 'Uno', icon: 'abc', features: ['NEWS'] });
    expect(directory.channelsOf(G1)).toEqual([TEXT, VOICE]);
    send('CHANNEL_UPDATE', { ...TEXT, name: 'lobby', guild_id: G1 });
    send('CHANNEL_DELETE', { ...VOICE, guild_id: G1 });
    expect(directory.channelsOf(G1)).toEqual([{ ...TEXT, name: 'lobby', guild_id: G1 }]);
    // An outage keeps the server; leaving it removes it.
    send('GUILD_DELETE', { id: G1, unavailable: true });
    expect(directory.guildList().map((g) => g.id)).toEqual([G1, G2]);
    send('GUILD_DELETE', { id: G1 });
    expect(directory.guildList().map((g) => g.id)).toEqual([G2]);
  });

  it('refreshes the archive directory from the gateway, with no request', async () => {
    const { send, directory } = gateway();
    send('READY', { guilds: [{ id: G1, properties: { name: 'One' }, channels: [TEXT, VOICE] }] });
    const calls: [string, ...unknown[]][] = [];
    const core = { call: async (method: string, ...args: unknown[]) => void calls.push([method, ...args]) };
    const api = { get: vi.fn() };
    const sync = new SyncService(api as never, core as never, () => undefined, directory);
    await sync.refreshDirectory();
    await sync.refreshDirectory(G1);
    await expect(sync.refreshDirectory(G2)).rejects.toThrow("hasn't loaded this server");
    expect(api.get).not.toHaveBeenCalled();
    expect(calls).toEqual([
      ['upsertGuilds', [{ id: G1, name: 'One' }]],
      ['upsertChannels', G1, [TEXT]],
    ]);
  });

  it('probes session health from what main already holds', () => {
    const { tap, send, directory } = gateway();
    send('READY', { guilds: [{ id: G1, properties: { name: 'One' }, channels: [] }] });
    const capture = { current: { authorization: 't', extra: {}, capturedAt: 5 }, observedLimits: [50] };
    const stats = { compress: null, frames: 1, decodeErrors: 0, events: {} };
    const p = probeDiscord(capture as never, Object.assign(tap, { stats }) as never, [], { username: 'me' }, directory);
    expect(p).toMatchObject({ loggedIn: true, username: 'me', guildCount: 1, error: null });
  });
});
