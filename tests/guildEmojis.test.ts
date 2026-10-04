import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DiscordApi } from '../src/main/discord/api';
import type { GatewayDispatch, GatewayTap } from '../src/main/discord/gatewayTap';
import { GuildEmojiIndex } from '../src/main/discord/guildEmojis';

let tap: EventEmitter<{ dispatch: [GatewayDispatch] }>;
let index: GuildEmojiIndex;
let fetched: string[];
const api = {
  get: async (path: string) => {
    fetched.push(path);
    return [{ id: '9', name: 'fetched' }];
  },
} as unknown as DiscordApi;
const send = (t: string, d: unknown): boolean => tap.emit('dispatch', { t, s: null, d });
const names = (): string[] => index.all().map((e) => `${e.guildId}:${e.name}`);

beforeEach(() => {
  tap = new EventEmitter();
  index = new GuildEmojiIndex(tap as unknown as GatewayTap);
  fetched = [];
});

describe('guild emoji index', () => {
  it("indexes every server's usable emojis from READY, sorted by name, skipping unavailable ones", () => {
    send('READY', {
      guilds: [
        { id: 'g1', emojis: [{ id: '2', name: 'zeta' }, { id: '1', name: 'alpha', animated: true }, { id: '3', name: 'gone', available: false }] },
        { id: 'g2', emojis: [{ id: '4', name: 'pog' }] },
        { id: 'g3', unavailable: true },
      ],
    });
    expect(names()).toEqual(['g1:alpha', 'g1:zeta', 'g2:pog']);
    expect(index.all()[0]).toEqual({ id: '1', name: 'alpha', animated: true, guildId: 'g1' });
  });

  it('follows servers joined, emoji edits and servers left, but keeps a server through an outage', () => {
    send('READY', { guilds: [{ id: 'g1', emojis: [{ id: '1', name: 'a' }] }] });
    send('GUILD_CREATE', { id: 'g2', emojis: [{ id: '2', name: 'b' }] });
    send('GUILD_EMOJIS_UPDATE', { guild_id: 'g1', emojis: [{ id: '3', name: 'c' }] });
    send('GUILD_DELETE', { id: 'g2', unavailable: true });
    expect(names()).toEqual(['g1:c', 'g2:b']);
    send('GUILD_DELETE', { id: 'g2' });
    expect(names()).toEqual(['g1:c']);
  });

  it('fetches a server the gateway did not cover once, then serves it from the index', async () => {
    send('READY', { guilds: [{ id: 'g1', emojis: [{ id: '1', name: 'a' }] }] });
    expect(await index.forGuild(api, 'g1')).toHaveLength(1);
    expect(fetched).toEqual([]);
    await index.forGuild(api, 'g5');
    await index.forGuild(api, 'g5');
    expect(fetched).toEqual(['guilds/g5/emojis']);
    expect(names()).toContain('g5:fetched');
  });
});
